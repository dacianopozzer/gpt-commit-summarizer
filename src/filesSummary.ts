import { octokit } from './octokit'
import { PayloadRepository } from '@actions/github/lib/interfaces'
import { SHARED_PROMPT } from './sharedPrompt'
import { MAX_OPEN_AI_QUERY_LENGTH, MAX_TOKENS, MODEL_NAME, openai, TEMPERATURE } from './openAi'

const OPEN_AI_PROMPT = `${SHARED_PROMPT}
The following is a git diff of a single file.
Please summarize it in a comment, describing the changes made in the diff in high level.
Do it in the following way:
Write \`ANALYSIS:\` and then write a detailed description of all changes made in the diff.
Then write \`SUMMARY:\` and then write a summary of the changes made in the diff, as a bullet point list.
Every bullet point should start with a \`*\`.
`

// const MAX_FILES_TO_SUMMARIZE = 1

async function getOpenAISummaryForFile (filename: string, patch: string): Promise<string> {
  const openAIPrompt = `${OPEN_AI_PROMPT}\n\nTHE GIT DIFF OF ${filename} TO BE SUMMARIZED:\n\`\`\`\n${patch}\n\`\`\`\n\nANALYSIS:\n`
  console.log(`OpenAI file summary prompt: ${openAIPrompt}`)

  if (openAIPrompt.length > MAX_OPEN_AI_QUERY_LENGTH) {
    throw new Error('OpenAI query too big')
  }

  const response = await openai.createCompletion({
    model: MODEL_NAME,
    prompt: openAIPrompt,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE
  })
  console.log('Raw openAI response:', response.data)
  if (response.data.choices !== undefined && response.data.choices.length > 0) {
    return response.data.choices[0].text ?? "Error: couldn't generate summary"
  }
  return "Error: couldn't generate summary"
}

async function getReviewComments (pullRequestNumber: number, repository: PayloadRepository): Promise<string[]> {
  const reviewComments = (await octokit.paginate(octokit.pulls.listReviewComments, {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullRequestNumber
  }) as unknown as Awaited<ReturnType<typeof octokit.pulls.listReviewComments>>)
  console.log('reviewComments:\n', reviewComments)
  return (reviewComments as unknown as Array<{ body?: string }>).map((reviewComment) => reviewComment.body ?? '')
}

export async function getFilesSummaries (pullNumber: number,
  repository: PayloadRepository): Promise<Record<string, string>> {
  const filesChanged = await octokit.pulls.listFiles({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullNumber
  })
  const modifiedFiles: Record<string, { sha: string, diff: string }> = {}
  for (const file of filesChanged.data) {
    modifiedFiles[file.filename] = { sha: file.sha, diff: file.patch ?? '' }
  }
  const existingReviewSummaries = await getReviewComments(pullNumber, repository)
  const result: Record<string, string> = {}
  for (const modifiedFile of Object.keys(modifiedFiles)) {
    let isFileAlreadySummarized = false
    const expectedComment = `GPT summary of ${modifiedFiles[modifiedFile].sha}:`
    for (const reviewSummary of existingReviewSummaries) {
      if (reviewSummary.includes(expectedComment)) {
        const summary = reviewSummary.split('\n').slice(1).join('\n')
        result[modifiedFile] = summary
        isFileAlreadySummarized = true
        break
      }
    }
    if (isFileAlreadySummarized) {
      continue
    }
    const fileAnalysisAndSummary = await getOpenAISummaryForFile(modifiedFile, modifiedFiles[modifiedFile].diff)
    console.log(fileAnalysisAndSummary)
    console.log(OPEN_AI_PROMPT)
    result[modifiedFile] = fileAnalysisAndSummary
    break
  }
  return result
}

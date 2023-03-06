import type { gitDiffMetadata } from "./DiffMetadata";
import { octokit } from "./octokit";
import {
  MAX_OPEN_AI_QUERY_LENGTH,
  MAX_TOKENS,
  MODEL_NAME,
  openai,
  TEMPERATURE,
} from "./openAi";
import { SHARED_PROMPT } from "./sharedPrompt";
import { summarizePr } from "./summarizePr";

const OPEN_AI_PRIMING = `${SHARED_PROMPT}
Após o git diff do primeiro arquivo, haverá uma linha vazia e, em seguida, o git diff do próximo arquivo.

Para comentários que se referem a 1 ou 2 arquivos modificados,
adicione os nomes dos arquivos como [path/to/modified/python/file.py], [path/to/another/file.json]
no final do comentário.
Se houver mais de dois, não inclua os nomes dos arquivos dessa maneira.
Não inclua o nome do arquivo como outra parte do comentário, apenas no final no formato especificado.
Não use os caracteres \`[\` ou \`]\` no resumo para outros fins.
Escreva cada comentário resumido em uma nova linha.
Os comentários devem estar em uma lista de marcadores, cada linha começando com \`*\`.
O resumo não deve incluir comentários copiados do código.
A saída deve ser facilmente legível. Em caso de dúvida, escreva menos comentários e não mais.
A legibilidade é a principal prioridade. Escreva apenas os comentários mais importantes sobre o diff.
Se o código tiver algum erro, solicite uma revisão.

EXEMPLO DE COMENTÁRIOS DE RESUMO:
\`\`\`
* Aumentou a quantidade de gravações retornadas de \`10\` para \`100\` [packages/server/recordings_api.ts], [packages/server/constants.ts]
* Corrigido um erro de digitação no nome da ação do github [.github/workflows/gpt-commit-summarizer.yml]
* Movida a inicialização do \`octokit\` para um arquivo separado [src/octokit.ts], [src/index.ts]
* Adicionado uma API OpenAI para conclusões [packages/utils/apis/openai.ts]
* Tolerância numérica reduzida para arquivos de teste
* Este código possui erros, reveja os mesmos na linha X e método Y
\`\`\`
A maioria dos commits terá menos comentários do que esta lista de exemplos.
O último comentário não inclui os nomes dos arquivos,
porque havia mais de dois arquivos relevantes no commit hipotético.
Não inclua partes do exemplo em seu resumo.
É dado apenas como um exemplo de comentários apropriados.
`;

const MAX_COMMITS_TO_SUMMARIZE = 20;

function formatGitDiff(filename: string, patch: string): string {
  const result = [];
  result.push(`--- a/${filename}`);
  result.push(`+++ b/${filename}`);
  for (const line of patch.split("\n")) {
    result.push(line);
  }
  result.push("");
  return result.join("\n");
}

function postprocessSummary(
  filesList: string[],
  summary: string,
  diffMetadata: gitDiffMetadata
): string {
  for (const fileName of filesList) {
    const splitFileName = fileName.split("/");
    const shortName = splitFileName[splitFileName.length - 1];
    const link =
      "https://github.com/" +
      `${diffMetadata.repository.owner.login}/` +
      `${diffMetadata.repository.name}/blob/` +
      `${diffMetadata.commit.data.sha}/` +
      `${fileName}`;
    summary = summary.split(`[${fileName}]`).join(`[${shortName}](${link})`);
  }
  return summary;
}

async function getOpenAICompletion(
  comparison: Awaited<ReturnType<typeof octokit.repos.compareCommits>>,
  completion: string,
  diffMetadata: gitDiffMetadata
): Promise<string> {
  try {
    const diffResponse = await octokit.request(comparison.url);

    const rawGitDiff = diffResponse.data.files
      .map((file: any) => formatGitDiff(file.filename, file.patch))
      .join("\n");
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    const openAIPrompt = `${OPEN_AI_PRIMING}\n\nA DIFF DO GIT A SER RESUMIDA:\n\`\`\`\n${rawGitDiff}\n\`\`\`\n\nO RESUMO:\n\nERROR:\n`;

    console.log(
      `OpenAI prompt for commit ${diffMetadata.commit.data.sha}: ${openAIPrompt}`
    );

    if (openAIPrompt.length > MAX_OPEN_AI_QUERY_LENGTH) {
      throw new Error("OpenAI query too big");
    }

    const response = await openai.createCompletion({
      model: MODEL_NAME,
      prompt: openAIPrompt,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });

    if (
      response.data.choices !== undefined &&
      response.data.choices.length > 0
    ) {
      completion = postprocessSummary(
        diffResponse.data.files.map((file: any) => file.filename),
        response.data.choices[0].text ?? "Error: couldn't generate summary",
        diffMetadata
      );
    }
  } catch (error) {
    console.error(error);
  }
  return completion;
}

export async function summarizeCommits(
  pullNumber: number,
  repository: { owner: { login: string }; name: string },
  modifiedFilesSummaries: Record<string, string>
): Promise<Array<[string, string]>> {
  const commitSummaries: Array<[string, string]> = [];

  const pull = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullNumber,
  });

  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner: repository.owner.login,
    repo: repository.name,
    issue_number: pullNumber,
  });

  let commitsSummarized = 0;

  // For each commit, get the list of files that were modified
  const commits = await octokit.paginate(octokit.pulls.listCommits, {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pullNumber,
  });

  const headCommit = pull.data.head.sha;

  let needsToSummarizeHead = false;
  for (const commit of commits) {
    // Check if a comment for this commit already exists
    const expectedComment = `GPT resumo do sha ${commit.sha}:`;
    const regex = new RegExp(`^${expectedComment}.*`);
    const existingComment = comments.find((comment) =>
      regex.test(comment.body ?? "")
    );

    // If a comment already exists, skip this commit
    if (existingComment !== undefined) {
      const currentCommitAbovePrSummary =
        existingComment.body?.split("PR resumo para:")[0] ?? "";
      const summaryLines = currentCommitAbovePrSummary
        .split("\n")
        .slice(1)
        .join("\n");
      commitSummaries.push([commit.sha, summaryLines]);
      continue;
    }

    if (commit.sha === headCommit) {
      needsToSummarizeHead = true;
    }

    // Get the commit object with the list of files that were modified
    const commitObject = await octokit.repos.getCommit({
      owner: repository.owner.login,
      repo: repository.name,
      ref: commit.sha,
    });

    if (commitObject.data.files === undefined) {
      throw new Error("Files undefined");
    }

    const isMergeCommit = commitObject.data.parents.length !== 1;
    const parent = commitObject.data.parents[0].sha;

    const comparison = await octokit.repos.compareCommits({
      owner: repository.owner.login,
      repo: repository.name,
      base: parent,
      head: commit.sha,
    });

    let completion = "Error: couldn't generate summary";
    if (!isMergeCommit) {
      completion = await getOpenAICompletion(comparison, completion, {
        sha: commit.sha,
        issueNumber: pullNumber,
        repository,
        commit: commitObject,
      });
    } else {
      completion = "Not generating summary for merge commits";
    }

    commitSummaries.push([commit.sha, completion]);

    // Create a comment on the pull request with the names of the files that were modified in the commit
    const comment = `GPT resumo de ${commit.sha}:\n\n${completion}`;

    if (commit.sha !== headCommit) {
      await octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: pullNumber,
        body: comment,
        commit_id: commit.sha,
      });
    }
    commitsSummarized++;
    if (commitsSummarized >= MAX_COMMITS_TO_SUMMARIZE) {
      console.log(
        "Max commits summarized - if you want to summarize more, rerun the action. This is a protection against spamming the PR with comments"
      );
      break;
    }
  }
  const headCommitShaAndSummary = commitSummaries.find(
    ([sha]) => sha === headCommit
  );
  if (needsToSummarizeHead && headCommitShaAndSummary !== undefined) {
    let prSummary = "Error summarizing PR";
    try {
      prSummary = await summarizePr(modifiedFilesSummaries, commitSummaries);
    } catch (error) {
      console.error(error);
    }
    const comment = `GPT resumo de ${headCommit}:\n\n${headCommitShaAndSummary[1]}\n\nPR resumo:\n\n${prSummary}`;
    await octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: pullNumber,
      body: comment,
      commit_id: headCommit,
    });
  }
  return commitSummaries;
}

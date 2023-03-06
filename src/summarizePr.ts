import {
  MAX_OPEN_AI_QUERY_LENGTH,
  MAX_TOKENS,
  MODEL_NAME,
  openai,
  TEMPERATURE,
} from "./openAi";

const OPEN_AI_PROMPT = `Você é um programador especialista e está tentando resumir uma solicitação pull.
Você examinou todos os commits que fazem parte da solicitação pull e todos os arquivos que foram alterados nele.
Para alguns deles, houve um erro no resumo do commit ou no resumo do diff dos arquivos.
Resuma a solicitação pull. Escreva sua resposta em marcadores, iniciando cada marcador com um \`*\`.
Escreva uma descrição de alto nível. Não repita os resumos de confirmação ou os resumos de arquivo.
Escreva os pontos mais importantes. A lista não deve ter mais do que alguns marcadores.
`;

const linkRegex = /\[.*?\]\(https:\/\/github\.com\/.*?[a-zA-Z0-f]{40}\/(.*?)\)/;

function preprocessCommitMessage(commitMessage: string): string {
  let match = commitMessage.match(linkRegex);
  while (match !== null) {
    commitMessage = commitMessage.split(match[0]).join(`[${match[1]}]`);
    match = commitMessage.match(linkRegex);
  }
  return commitMessage;
}

export async function summarizePr(
  fileSummaries: Record<string, string>,
  commitSummaries: Array<[string, string]>
): Promise<string> {
  const commitsString = Array.from(commitSummaries.entries())
    .map(
      ([idx, [, summary]]) =>
        `Commit #${idx + 1}:\n${preprocessCommitMessage(summary)}`
    )
    .join("\n");
  const filesString = Object.entries(fileSummaries)
    .map(([filename, summary]) => `File ${filename}:\n${summary}`)
    .join("\n");
  const openAIPrompt = `${OPEN_AI_PROMPT}\n\nRESUMO DO COMMIT:\n\`\`\`\n${commitsString}\n\`\`\`\n\nRESUMO DO ARQUIVO:\n\`\`\`\n${filesString}\n\`\`\`\n\n
  Lembrete - escreva apenas os pontos mais importantes. Não mais do que alguns marcadores.
  O RESUMO DO PEDIDO DE PULL:\n`;
  console.log(`OpenAI for PR summary prompt:\n${openAIPrompt}`);

  if (openAIPrompt.length > MAX_OPEN_AI_QUERY_LENGTH) {
    return "Error: couldn't generate summary. PR too big";
  }

  try {
    const response = await openai.createCompletion({
      model: MODEL_NAME,
      prompt: openAIPrompt,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
    return response.data.choices[0].text ?? "Error: couldn't generate summary";
  } catch (error) {
    console.error(error);
    return "Error: couldn't generate summary";
  }
}

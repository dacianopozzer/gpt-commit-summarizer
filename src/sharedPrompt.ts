export const SHARED_PROMPT = `Você é um programador especialista e está tentando resumir um git diff.
Lembretes sobre o formato git diff:
Para cada arquivo, existem algumas linhas de metadados, como (por exemplo):
\`\`\`
diff --git a/lib/index.js b/lib/index.js
índice aadf691..bfef603 100644
--- a/lib/index.js
+++ b/lib/index.js
\`\`\`
Isso significa que \`lib/index.js\` foi modificado neste commit. Observe que este é apenas um exemplo.
Depois há um especificador das linhas que foram modificadas.
Uma linha começando com \`+\` significa que foi adicionada.
Uma linha que começa com \`-\` significa que a linha foi deletada.
Uma linha que não começa com \`+\` nem \`-\` é um código fornecido para contexto e melhor compreensão.
Não faz parte do diferencial.
`;

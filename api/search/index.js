// api/search/index.js

const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { AzureOpenAI } = require("openai");

// Hilfsfunktion: Fallback-Antwort nur mit erstem Dokument
function buildSimpleSnippetAnswer(results) {
  const firstDoc = results[0].document;

  const title =
    firstDoc.title ||
    firstDoc.fileName ||
    firstDoc.file_name ||
    firstDoc.metadata_title ||
    firstDoc.filename ||
    "Gefundenes Dokument";

  const contentSnippet =
    (
      firstDoc.content ||
      firstDoc.chunk ||
      firstDoc.pageContent ||
      firstDoc.text ||
      firstDoc.page_text ||
      ""
    )
      .toString()
      .slice(0, 400);

  return (
    `Ich habe folgendes Dokument gefunden:\n\n` +
    `Titel: ${title}\n\nAusschnitt:\n${contentSnippet}`
  );
}

module.exports = async function (context, req) {
  context.log("HTTP trigger 'search' processed a request.");

  try {
    // Query aus Body (Frontend schickt { query: "..." })
    const query = req.body?.query || req.query?.q;
    if (!query) {
      context.res = {
        status: 400,
        body: { error: "Missing 'query' in request body." }
      };
      return;
    }

    // --- Azure AI Search Settings ---
    const searchEndpoint = process.env.SEARCH_ENDPOINT;
    const searchKey = process.env.SEARCH_KEY;

    // bevorzugt RAG-Index, fallback auf normalen Index
    const indexName =
      process.env.SEARCH_INDEX_RAG || process.env.SEARCH_INDEX;

    if (!searchEndpoint || !searchKey || !indexName) {
      context.log.error(
        "Missing SEARCH_ENDPOINT / SEARCH_KEY / SEARCH_INDEX_RAG or SEARCH_INDEX env var(s)."
      );
      context.res = {
        status: 500,
        body: { error: "Search service not configured." }
      };
      return;
    }

    context.log("Using search index:", indexName);

    const searchClient = new SearchClient(
      searchEndpoint,
      indexName,
      new AzureKeyCredential(searchKey)
    );

    const searchOptions = {
      top: 5,
      includeTotalCount: true
      // Wenn du Semantic Search aktiviert hast, kannst du das hier einschalten:
      // queryType: "semantic",
      // semanticConfiguration: "default",
    };

    const searchResultsIterator = await searchClient.search(query, searchOptions);

    const results = [];
    for await (const r of searchResultsIterator.results) {
      results.push({
        score: r.score,
        document: r.document
      });
    }

    context.log("Anzahl Treffer:", results.length);

    let answerText = "";

    if (results.length === 0) {
      // Keine Dokumente -> direkt antworten
      answerText =
        "Ich habe leider keine passenden Dokumente gefunden. Formuliere deine Frage bitte möglichst konkret oder prüfe, ob die Inhalte bereits im Index liegen.";
    } else {
      // --- Kontext aus mehreren Treffern bauen (für RAG) ---
      const docsForContext = results.slice(0, 4); // max. 4 Dokumente an das LLM geben

      const contextText = docsForContext
        .map((r, idx) => {
          const d = r.document;

          const title =
            d.title ||
            d.fileName ||
            d.file_name ||
            d.metadata_title ||
            d.filename ||
            `Dokument ${idx + 1}`;

          const content =
            d.content ||
            d.chunk ||
            d.pageContent ||
            d.text ||
            d.page_text ||
            "";

          const snippet = content.toString().slice(0, 1200); // pro Dokument begrenzen

          return `Dokument ${idx + 1}: ${title}\n${snippet}`;
        })
        .join("\n\n--------------------\n\n");

      // --- Azure OpenAI Settings ---
      const openaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const openaiKey = process.env.AZURE_OPENAI_API_KEY;
      const openaiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

      if (!openaiEndpoint || !openaiKey || !openaiDeployment) {
        context.log.warn(
          "Azure OpenAI nicht konfiguriert – sende nur einfachen Ausschnitt zurück."
        );
        answerText = buildSimpleSnippetAnswer(results);
      } else {
        try {
          // Client für Azure OpenAI
          const openai = new AzureOpenAI({
            endpoint: openaiEndpoint,
            apiKey: openaiKey,
            apiVersion: "2024-05-01-preview" // feste Version, kein extra Env-Var nötig
          });

          const messages = [
            {
              role: "system",
              content:
                "Du bist ein hilfreicher Assistent. Beantworte Fragen ausschließlich anhand der bereitgestellten Kontext-Dokumente. " +
                "Wenn etwas nicht im Kontext steht, sage ehrlich, dass du es nicht weißt. Antworte immer auf Deutsch, klar und knapp, " +
                "aber mit genug Details, dass der Nutzer etwas damit anfangen kann."
            },
            {
              role: "user",
              content:
                `Frage:\n${query}\n\n` +
                `Relevante Dokumente:\n${contextText}`
            }
          ];

          const completion = await openai.chat.completions.create({
            model: openaiDeployment,
            messages,
            temperature: 0.2,
            max_tokens: 700
          });

          answerText =
            completion.choices?.[0]?.message?.content?.trim() ||
            buildSimpleSnippetAnswer(results);
        } catch (openaiErr) {
          context.log.error("Fehler beim Aufruf von Azure OpenAI:", openaiErr);
          // Fallback, falls das LLM nicht funktioniert
          answerText = buildSimpleSnippetAnswer(results);
        }
      }
    }

    // Antwort für dein Frontend (data.answer)
    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: {
        query,
        results,
        answer: answerText
      }
    };
  } catch (err) {
    context.log.error("Search function error:", err);
    context.res = {
      status: 500,
      body: { error: "Search failed", details: err.message }
    };
  }
};

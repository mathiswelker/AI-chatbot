// api/search/index.js (oder dein Function-Pfad)

const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");

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

    // Environment-Variablen
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

    // Search Client
    const client = new SearchClient(
      searchEndpoint,
      indexName,
      new AzureKeyCredential(searchKey)
    );

    // Suche starten (RAG-Index kann trotzdem normal mit query durchsucht werden)
    const searchOptions = {
      top: 5,
      includeTotalCount: true
      // optional: weitere Optionen wie semantic search, filter, etc.
      // queryType: "semantic",
      // queryLanguage: "de-de",
    };

    const resultsIterator = await client.search(query, searchOptions);

    const results = [];
    for await (const r of resultsIterator.results) {
      results.push({
        score: r.score,
        document: r.document
      });
    }

    context.log("Anzahl Treffer:", results.length);

    // Antworttext fürs Frontend bauen
    let answerText = "";

    if (results.length === 0) {
      answerText = "Ich habe leider keine passenden Dokumente gefunden.";
    } else {
      const firstDoc = results[0].document;

      // Titel-Feld: versuche mehrere typische RAG-Felder
      const title =
        firstDoc.title ||
        firstDoc.fileName ||
        firstDoc.file_name ||
        firstDoc.metadata_title ||
        firstDoc.filename ||
        "Gefundenes Dokument";

      // Inhaltsfeld: versuche mehrere typische Feldnamen
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

      answerText =
        `Ich habe folgendes Dokument gefunden:\n\n` +
        `Titel: ${title}\n\nAusschnitt:\n${contentSnippet}`;
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

// /api/ragSearch/index.js (oder wie deine Function heißt)

const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { AzureOpenAI } = require("openai");

module.exports = async function (context, req) {
  try {
    const query = req.body && req.body.query;
    if (!query) {
      context.res = {
        status: 400,
        body: { error: "Missing 'query' in request body." }
      };
      return;
    }

    // ==== ENV VARS (App Settings in Azure) ====
    const searchEndpoint = process.env.SEARCH_ENDPOINT;       // z.B. https://xxx.search.windows.net
    const searchKey      = process.env.SEARCH_KEY;
    const indexName      = process.env.SEARCH_INDEX_RAG;

    const aoaiEndpoint   = process.env.AZURE_OPENAI_ENDPOINT; // z.B. https://xxx.openai.azure.com
    const aoaiKey        = process.env.AZURE_OPENAI_API_KEY;
    const aoaiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT; // Name des Deployments (z.B. "gpt-4o-mini")
    const aoaiApiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

    if (!searchEndpoint || !searchKey || !indexName) {
      context.log.error("Missing SEARCH_ENDPOINT / SEARCH_KEY / SEARCH_INDEX_RAG env var(s).");
      context.res = {
        status: 500,
        body: { error: "Search service not configured." }
      };
      return;
    }

    if (!aoaiEndpoint || !aoaiKey || !aoaiDeployment) {
      context.log.error("Missing AZURE_OPENAI_* env vars.");
      context.res = {
        status: 500,
        body: { error: "Azure OpenAI not configured." }
      };
      return;
    }

    // ==== 1. Azure AI Search: passende Textstellen holen ====
    const searchClient = new SearchClient(
      searchEndpoint,
      indexName,
      new AzureKeyCredential(searchKey)
    );

    // Felder an dein Indexschema anpassen:
    // z.B. content = voller Text, title = Dokumenttitel, id = Schlüssel
    const searchResults = await searchClient.search(query, {
      top: 5,
      select: ["content", "title", "id"],   // <= HIER ggf. anpassen!
      queryType: "simple"
      // ggf. semantic search aktivieren:
      // queryType: "semantic",
      // semanticSearchOptions: { queryCaption: "extractive", queryAnswer: "extractive" }
    });

    const sources = [];
    for await (const result of searchResults.results) {
      const doc = result.document;
      sources.push({
        id: doc.id,
        title: doc.title,
        // etwas kürzen, damit nicht zu viel Kontext geschickt wird
        content: (doc.content || "").slice(0, 2000)
      });
    }

    if (sources.length === 0) {
      context.res = {
        status: 200,
        body: {
          answer: "Ich habe in den vorhandenen Dokumenten leider nichts Passendes gefunden.",
          sources: []
        }
      };
      return;
    }

    const contextText = sources
      .map((s, i) =>
        `Quelle ${i + 1} (Titel: ${s.title || "ohne Titel"}):\n${s.content}`
      )
      .join("\n\n-----\n\n");

    // ==== 2. Azure OpenAI: aus Kontext eine Antwort generieren ====
    const openai = new AzureOpenAI({
      endpoint: aoaiEndpoint,
      apiKey: aoaiKey,
      deployment: aoaiDeployment,
      apiVersion: aoaiApiVersion
    });

    const systemPrompt = `
Du bist ein deutschsprachiger Assistent für Bagger-Handbücher.
Antworte nur mit Informationen aus den bereitgestellten Quellen.
Wenn etwas nicht in den Quellen steht, sag ehrlich, dass du es nicht weißt.
Gib klare, kurze Schritt-für-Schritt-Anweisungen, keine langen Romantexte.
    `.trim();

    const userPrompt = `
Frage des Benutzers:
${query}

Verwende ausschließlich die folgenden Ausschnitte aus dem Handbuch, um die Frage zu beantworten.
Wenn mehrere Quellen dasselbe beschreiben, fasse sie zusammen.

Quellen:
${contextText}
    `.trim();

    const completion = await openai.chat.completions.create({
      model: aoaiDeployment, // bei Azure: hier der Deployment-Name
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 800
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Es konnte keine sinnvolle Antwort generiert werden.";

    // ==== 3. Antwort zurück an dein Frontend ====
    context.res = {
      status: 200,
      body: {
        answer,
        sources // optional, kannst du im UI als „Gefundene Dokumente“ anzeigen
      }
    };
  } catch (err) {
    context.log.error("RAG error", err);
    context.res = {
      status: 500,
      body: { error: "Internal server error", detail: String(err.message || err) }
    };
  }
};



"use strict";

const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { AzureOpenAI } = require("openai");

/**
 * HTTP-Trigger-Funktion für RAG (Azure AI Search + Azure OpenAI).
 *
 * Request-Body:
 *  { "query": "deine Frage" }
 *
 * Response (200):
 *  {
 *    "answer": "Antwort des Chatbots",
 *    "sources": [ ... getroffene Dokumente ... ]
 *  }
 */
module.exports = async function (context, req) {
  context.log("RAG-Function aufgerufen.");

  try {
    // -------- 1. User-Query einlesen --------
    const query =
      (req.body && req.body.query) ||
      (req.query && req.query.q) ||
      null;

    context.log("User-Query:", query);

    if (!query) {
      context.res = {
        status: 400,
        body: { error: "Missing 'query' in request body." }
      };
      return;
    }

    // -------- 2. Environment-Variablen einlesen --------
    const searchEndpoint = process.env.SEARCH_ENDPOINT;
    const searchKey = process.env.SEARCH_KEY;
    const indexName = process.env.SEARCH_INDEX_RAG;

    const aoaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const aoaiKey = process.env.AZURE_OPENAI_API_KEY;
    const aoaiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const aoaiApiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";

    // Nur „ungefährliche“ Infos loggen (keine Keys!)
    context.log("searchEndpoint:", searchEndpoint);
    context.log("indexName:", indexName);
    context.log("aoaiEndpoint:", aoaiEndpoint);
    context.log("aoaiDeployment:", aoaiDeployment);

    if (!searchEndpoint || !searchKey || !indexName) {
      throw new Error(
        "Search service not configured. CHECK: SEARCH_ENDPOINT / SEARCH_KEY / SEARCH_INDEX_RAG"
      );
    }
    if (!aoaiEndpoint || !aoaiKey || !aoaiDeployment) {
      throw new Error(
        "Azure OpenAI not configured. CHECK: AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT"
      );
    }

    // -------- 3. Azure AI Search: Dokumente holen --------
    const searchClient = new SearchClient(
      searchEndpoint,
      indexName,
      new AzureKeyCredential(searchKey)
    );

    // WICHTIG: Felder an dein Index-Schema anpassen!
    // "id", "title", "content" müssen im Index existieren.
    const searchResults = await searchClient.search(query, {
      top: 5,
      select: ["id", "title", "content"],
      queryType: "simple"
    });

    const sources = [];
    for await (const result of searchResults.results) {
      const doc = result.document;
      sources.push({
        id: doc.id,
        title: doc.title,
        // Text etwas beschneiden, damit nicht zu viel an OpenAI geht
        content: (doc.content || "").slice(0, 2000)
      });
    }

    if (sources.length === 0) {
      context.res = {
        status: 200,
        body: {
          answer:
            "Ich habe in den vorhandenen Dokumenten keine passenden Informationen gefunden.",
          sources: []
        }
      };
      return;
    }

    // Kontext-Text für das LLM zusammenbauen
    const contextText = sources
      .map(
        (s, i) =>
          `Quelle ${i + 1} (Titel: ${s.title || "ohne Titel"}):\n${s.content}`
      )
      .join("\n\n-----\n\n");

    // -------- 4. Azure OpenAI: Antwort generieren --------
    const client = new AzureOpenAI({
      endpoint: aoaiEndpoint,
      apiKey: aoaiKey,
      deployment: aoaiDeployment,
      apiVersion: aoaiApiVersion
    });

    const systemPrompt = `
Du bist ein deutschsprachiger Assistent für Bagger-Handbücher.
Antworte nur mit Informationen aus den bereitgestellten Quellen.
Wenn etwas nicht in den Quellen steht, sag ehrlich, dass du es nicht weißt.
Antworte kurz, klar und in verständlichem Deutsch.
    `.trim();

    const userPrompt = `
Frage des Benutzers:
${query}

Nutze ausschließlich die folgenden Ausschnitte aus dem Handbuch, um die Frage zu beantworten.
Wenn die Information nicht enthalten ist, erkläre das.

Quellen:
${contextText}
    `.trim();

    const compl


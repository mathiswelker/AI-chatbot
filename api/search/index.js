const { AzureKeyCredential, AzureSearchClient } = require("@azure/search-documents");
const { OpenAIClient } = require("@azure/openai");

module.exports = async function (context, req) {
    context.log("RAG Function: Request received.");

    // --- 1. Konfiguration prüfen ---
    const query = req.body?.query;
    if (!query) {
        context.res = {
            status: 400,
            body: { error: "Query parameter is required." }
        };
        return;
    }

    const searchEndpoint = process.env.SEARCH_ENDPOINT;
    const searchKey = process.env.SEARCH_KEY;
    const indexName = process.env.SEARCH_INDEX_RAG || process.env.SEARCH_INDEX;
    const openaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const openaiKey = process.env.AZURE_OPENAI_KEY;
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

    // Finaler Check der Umgebungsvariablen (zur Sicherheit)
    if (!searchEndpoint || !searchKey || !indexName || !openaiEndpoint || !openaiKey || !deploymentName) {
        const missing = [
            !searchEndpoint ? "SEARCH_ENDPOINT" : null,
            !searchKey ? "SEARCH_KEY" : null,
            !indexName ? (process.env.SEARCH_INDEX_RAG ? "SEARCH_INDEX_RAG" : "SEARCH_INDEX") : null,
            !openaiEndpoint ? "AZURE_OPENAI_ENDPOINT" : null,
            !openaiKey ? "AZURE_OPENAI_KEY" : null,
            !deploymentName ? "AZURE_OPENAI_DEPLOYMENT_NAME" : null,
        ].filter(Boolean).join(", ");

        context.log.error(`SERVER CONFIG ERROR: Missing environment variables: ${missing}`);
        context.res = {
            status: 500,
            body: { 
                error: "Server Config Error: Missing required environment variables.",
                details: `Please set the following: ${missing}` 
            }
        };
        return;
    }

    // --- 2. Azure Search (Retrieval) ---
    let contextText = "";
    try {
        const searchClient = new AzureSearchClient(searchEndpoint, new AzureKeyCredential(searchKey), indexName);
        context.log("Attempting Azure Search call...");

        const searchOptions = {
            queryType: "semantic",
            semanticSearch: {
                configurationName: "default", // Passen Sie dies bei Bedarf an
                maxAnswerCount: 1,
            },
            select: ["content"],
            top: 3, // Holen Sie sich die Top 3 Dokumente
        };

        // Rufen Sie die Azure Search API auf
        const searchResults = await searchClient.search(query, searchOptions);
        let hitCount = 0;

        for await (const result of searchResults.results) {
            contextText += result.document.content + "\n\n";
            hitCount++;
        }
        
        context.log(`Azure Search Hits: ${hitCount}. Context Text Length: ${contextText.length}`);

        if (contextText.length === 0) {
            context.log("RAG FALLBACK: Search returned no results. Using generic fallback.");
            contextText = "Es konnten keine relevanten Dokumente gefunden werden. Bitte formulieren Sie die Frage neu.";
        }

    } catch (error) {
        context.log.error(`RAG FATAL ERROR during Azure Search: ${error.message}`);
        context.res = {
            status: 500,
            body: { 
                error: "Error during document retrieval.",
                details: `Search Error: ${error.message}` 
            }
        };
        return;
    }

    // --- 3. Azure OpenAI (Generation) ---
    try {
        const systemPrompt = `Sie sind ein hilfreicher Assistent. Generieren Sie eine präzise und freundliche Antwort basierend auf dem bereitgestellten Kontext. Wenn der Kontext die Frage nicht beantwortet, sagen Sie, dass Sie die Antwort nicht kennen. Kontext: ${contextText}`;

        const openaiClient = new OpenAIClient(openaiEndpoint, new AzureKeyCredential(openaiKey));
        
        // DIES IST DIE ZEILE, DIE DEN TIMEOUT VERURSACHT!
        context.log(`Sending request to OpenAI (Deployment: ${deploymentName})...`); 

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: query },
        ];

        const chatCompletion = await openaiClient.getChatCompletions(
            deploymentName,
            messages,
            { temperature: 0.1, maxTokens: 800 } 
        );
        
        context.log("OpenAI Response received successfully.");

        const llmAnswer = chatCompletion.choices?.[0]?.message?.content || "Keine Antwort vom LLM erhalten.";

        context.res = {
            status: 200,
            body: { answer: llmAnswer, source: contextText }
        };

    } catch (error) {
        // Dieser Block fängt den 1-2 Minuten Timeout-Fehler!
        context.log.error(`RAG FATAL ERROR during OpenAI call: ${error.message}`);
        context.res = {
            status: 500,
            body: { 
                error: "Error during generation (Timeout or API failure).",
                details: `OpenAI Error: ${error.message}`
            }
        };
    }
};

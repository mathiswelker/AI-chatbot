
// --- 1. Imports ---
// Stellt sicher, dass diese Pakete in der package.json stehen!
const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { OpenAIClient, AzureKeyCredential: OpenAIKeyCredential } = require("@azure/openai"); 
// Hinweis: OpenAI nutzt oft auch 'AzureKeyCredential', wir benennen es hier zur Sicherheit um oder nutzen das vom SDK exportierte.

module.exports = async function (context, req) {
    context.log("HTTP trigger 'search' processed a request.");

    try {
        // --- 2. Input Validierung ---
        const query = req.body?.query || req.query?.q;
        if (!query) {
            context.res = {
                status: 400,
                body: { error: "Missing 'query' in request body." }
            };
            return;
        }

        // --- 3. Environment-Variablen laden ---
        // Azure Search
        const searchEndpoint = process.env.SEARCH_ENDPOINT;
        const searchKey = process.env.SEARCH_KEY;
        const indexName = process.env.SEARCH_INDEX_RAG || process.env.SEARCH_INDEX;
        
        // Azure OpenAI
        const openaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
        const openaiKey = process.env.AZURE_OPENAI_KEY;
        const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME; 
        
        // Check Search Vars
        if (!searchEndpoint || !searchKey || !indexName) {
            const msg = "Server Config Error: Missing SEARCH_ENDPOINT / SEARCH_KEY / SEARCH_INDEX.";
            context.log.error(msg);
            context.res = { status: 500, body: { error: msg } };
            return;
        }

        // Check OpenAI Vars
        if (!openaiEndpoint || !openaiKey || !deploymentName) {
            const msg = "Server Config Error: Missing AZURE_OPENAI_ENDPOINT / KEY / DEPLOYMENT_NAME.";
            context.log.error(msg);
            context.res = { status: 500, body: { error: msg } };
            return;
        }
        
        context.log(`Starting RAG flow. Index: ${indexName}, Deployment: ${deploymentName}`);

        // ----------------------------------------------------------------
        // SCHRITT A: RETRIEVAL (Suche in Azure AI Search)
        // ----------------------------------------------------------------

        const searchClient = new SearchClient(
            searchEndpoint,
            indexName,
            new AzureKeyCredential(searchKey)
        );

        // Wir holen die Top 5 Dokumente
        const searchOptions = {
            top: 5, 
            includeTotalCount: true
        };

        const resultsIterator = await searchClient.search(query, searchOptions);
        const results = [];
        
        for await (const r of resultsIterator.results) {
            results.push({
                score: r.score,
                document: r.document
            });
        }

        context.log("Azure Search Hits:", results.length);

        // ----------------------------------------------------------------
        // SCHRITT B: AUGMENTATION (Kontext bauen)
        // ----------------------------------------------------------------
        
        let contextText = "";
        
        if (results.length > 0) {
            contextText = results
                .slice(0, 5) 
                .map((r, index) => {
                    // Felder flexibel auslesen (content, chunk, text...)
                    const contentSnippet =
                        r.document.content || r.document.chunk || r.document.text || r.document.pageContent || "";
                    
                    // Kürzen auf 1500 Zeichen pro Chunk
                    const snippet = contentSnippet.toString().slice(0, 1500); 
                    
                    // Titel finden
                    const title = r.document.title || r.document.fileName || `Quelle ${index + 1}`;
                    
                    return `[Quelle ${index + 1} - ${title}]:\n${snippet}`; 
                })
                .join("\n---\n");
        } else {
            // Fallback Kontext, wenn nichts gefunden wurde
            contextText = "Keine relevanten Dokumente in der Datenbank gefunden.";
        }
        
        context.log("Context Text Length:", contextText.length);

        // ----------------------------------------------------------------
        // SCHRITT C: GENERATION (OpenAI Chat Completion)
        // ----------------------------------------------------------------

        const openaiClient = new OpenAIClient(
            openaiEndpoint,
            new OpenAIKeyCredential(openaiKey)
        );

        const systemPrompt = 
            "Du bist ein hilfreicher Assistent für interne Dokumente. " +
            "Antworte auf die Frage des Benutzers NUR basierend auf dem unten stehenden Quellmaterial. " +
            "Wenn das Quellmaterial die Antwort nicht enthält, sage: 'Dazu habe ich keine Informationen in den Dokumenten gefunden.' " +
            "Gib die Quellen an (z.B. [Quelle 1]).";

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Quellmaterial:\n---\n${contextText}\n---\nBenutzerfrage: ${query}` }
        ];

        context.log("Sending request to OpenAI...");

        const chatCompletion = await openaiClient.getChatCompletions(
            deploymentName, 
            messages,
            {
                temperature: 0.3, 
                maxTokens: 1000 
            }
        );

        let llmAnswer = chatCompletion.choices[0].message?.content;

        // Sicherheits-Check: Hat OpenAI eine leere Antwort geschickt?
        if (!llmAnswer || llmAnswer.trim() === "") {
            context.log.warn("WARNUNG: OpenAI hat eine leere Antwort zurückgegeben (evtl. Content Filter).");
            llmAnswer = "Ich konnte keine Antwort generieren (Möglicherweise blockiert durch Sicherheitsfilter oder leere Rückgabe).";
        } else {
            context.log("OpenAI Response received. Length:", llmAnswer.length);
        }

        // ----------------------------------------------------------------
        // SCHRITT D: OUTPUT
        // ----------------------------------------------------------------

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: {
                query,
                results, 
                answer: llmAnswer 
            }
        };
        
    } catch (err) {
        // --- ERROR HANDLING & LOGGING ---
        
        // Wir bauen eine detaillierte Fehlermeldung
        let errorMsg = err.message || "Unknown Error";
        let errorDetails = "";

        if (err.statusCode) {
            errorDetails = `HTTP Status: ${err.statusCode}`; // Z.B. 401, 404, 429
        } else if (err.code) {
            errorDetails = `Error Code: ${err.code}`; // Z.B. ENOTFOUND
        }

        const fullLogMessage = `RAG FATAL ERROR: ${errorMsg} | ${errorDetails}`;
        
        // WICHTIG: Das landet in deinem Log Stream
        context.log.error(fullLogMessage);
        
        context.res = {
            status: 500,
            body: { 
                error: "Internal Server Error during RAG process.",
                details: fullLogMessage // Frontend sieht das zum Debuggen
            }
        };
    }
};


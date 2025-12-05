// api/search/index.js

// --- 1. Imports ---
const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { OpenAIClient } = require("@azure/openai"); 

module.exports = async function (context, req) {
    context.log("HTTP trigger 'search' processed a request.");

    try {
        // --- 2. Abfrage extrahieren und validieren ---
        const query = req.body?.query || req.query?.q;
        if (!query) {
            context.res = {
                status: 400,
                body: { error: "Missing 'query' in request body." }
            };
            return;
        }

        // --- 3. Environment-Variablen laden ---
        
        // Azure Search Variablen
        const searchEndpoint = process.env.SEARCH_ENDPOINT;
        const searchKey = process.env.SEARCH_KEY;
        const indexName = process.env.SEARCH_INDEX_RAG || process.env.SEARCH_INDEX;
        
        // Azure OpenAI Variablen (NEU)
        const openaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
        const openaiKey = process.env.AZURE_OPENAI_KEY;
        const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME; 
        
        // Validierung der Search-Variablen
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

        // Validierung der OpenAI-Variablen (NEU)
        if (!openaiEndpoint || !openaiKey || !deploymentName) {
            context.log.error("Missing AZURE_OPENAI_ENDPOINT / KEY / DEPLOYMENT_NAME env var(s).");
            context.res = {
                status: 500,
                body: { error: "OpenAI service not configured for generation." }
            };
            return;
        }
        
        context.log("Using search index:", indexName);

        // ----------------------------------------------------------------
        // A. RETRIEVAL (Suche in Azure AI Search)
        // ----------------------------------------------------------------

        // Search Client initialisieren
        const searchClient = new SearchClient(
            searchEndpoint,
            indexName,
            new AzureKeyCredential(searchKey)
        );

        const searchOptions = {
            top: 5, // Wir holen die Top 5 Dokumente als Kontext
            includeTotalCount: true,
            // queryType: "semantic" // Optional, falls Semantic Search im Index konfiguriert ist
        };

        const resultsIterator = await searchClient.search(query, searchOptions);

        const results = [];
        for await (const r of resultsIterator.results) {
            results.push({
                score: r.score,
                document: r.document
            });
        }

        context.log("Anzahl Treffer:", results.length);
        // NEUE LOG-AUSGABE 1
        
        // ----------------------------------------------------------------
        // B. AUGMENTATION (Kontext für das LLM erstellen)
        // ----------------------------------------------------------------
        
        let contextText = "";
        if (results.length > 0) {
            contextText = results
                .slice(0, 5) 
                .map((r, index) => {
                    // Versuche typische Inhaltsfelder zu finden
                    const contentSnippet =
                        r.document.content || r.document.chunk || r.document.text || r.document.pageContent || "";
                    
                    // Limitiere den Chunk auf eine sichere Länge (z.B. 1500 Zeichen)
                    const snippet = contentSnippet.toString().slice(0, 1500); 
                    
                    // Versuche einen Dokumenttitel zu extrahieren
                    const title = r.document.title || r.document.fileName || `Quelle ${index + 1}`;
                    
                    // Erstelle den formatierten Kontext-Block
                    return `[Quelle ${index + 1} - ${title}]:\n${snippet}`; 
                })
                .join("\n---\n"); // Trenner zwischen den Quellblöcken
            
            context.log("Kontext für OpenAI vorbereitet.");
        } else {
            // Fallback, wenn nichts gefunden wird
            contextText = "Keine relevanten Dokumente gefunden. Antworte basierend auf deinem allgemeinen Wissen oder sage, dass die Information fehlt.";
        }
        
        // NEUE LOG-AUSGABE 2
        context.log("Generierter Kontext (Länge):", contextText.length);


        // ----------------------------------------------------------------
        // C. GENERATION (Antwort durch Azure OpenAI erstellen)
        // ----------------------------------------------------------------

        const openaiClient = new OpenAIClient(
            openaiEndpoint,
            new AzureKeyCredential(openaiKey)
        );

        // System-Prompt zur Steuerung des GPT-4o mini Modells
        const systemPrompt = 
            "Du bist ein hilfreicher und präziser Chatbot. Deine Aufgabe ist es, die Benutzerfrage strikt basierend auf dem unten bereitgestellten Quellmaterial zu beantworten. " +
            "Wenn die Antwort nicht in den Quellen enthalten ist, sage höflich, dass du die Information nicht finden konntest. " +
            "Antworte immer in der Sprache der Frage und füge für jede Antwortpassage, die du aus den Quellen generierst, Referenzen in Klammern hinzu (z.B. [Quelle 1])."; 

        const messages = [
            { role: "system", content: systemPrompt },
            // Zusammenführung von Kontext und Benutzerfrage in einem Prompt
            { role: "user", content: `Quellmaterial:\n---\n${contextText}\n---\nBenutzerfrage: ${query}` }
        ];

        const chatCompletion = await openaiClient.getChatCompletions(
            deploymentName, // Z.B. 'rag-gpt4o-mini'
            messages,
            {
                temperature: 0.2, // Niedrige Temperatur für faktenbasierte Antworten
                maxTokens: 1200 // Maximalbegrenzung der Antwortlänge
            }
        );

        let llmAnswer = chatCompletion.choices[0].message.content; // WICHTIG: 'const' durch 'let' ersetzt

        // NEUE LOG-AUSGABE 3 & FALLBACK
        context.log("LLM Antwort (Länge):", llmAnswer ? llmAnswer.length : "EMPTY");
        
        // --- Zusätzlicher Fallback-Check: Wenn LLM leer antwortet ---
        if (!llmAnswer || llmAnswer.trim() === "") {
             llmAnswer = "Entschuldigung, ich konnte keine passende Antwort generieren, auch nicht mit dem bereitgestellten Kontext.";
             context.log.warn("WARNUNG: Leere LLM-Antwort. Frontend erhält Fallback-Text.");
        }
        

        // ----------------------------------------------------------------
        // D. OUTPUT (Antwort an das Frontend senden)
        // ----------------------------------------------------------------

        context.res = {
            status: 200,
            headers: {
                "Content-Type": "application/json"
            },
            body: {
                query,
                results, 
                answer: llmAnswer // Die vom LLM generierte, aufbereitete Antwort!
            }
        };
        
    } catch (err) {
        // --- DETAIL-LOGGING-BLOCK (UNVERÄNDERT) ---
        let errorDetails = err.message || "Unbekannter Fehler im RAG-Prozess";
        
        if (err.statusCode) {
            errorDetails = `HTTP-Status: ${err.statusCode} | Meldung: ${err.message}`;
        } else if (err.code) {
             errorDetails = `Code: ${err.code} | Meldung: ${err.message}`;
        }
        
        context.log.error("RAG FATAL ERROR (Details):", errorDetails);
        
        context.res = {
            status: 500,
            body: { error: "RAG process failed", details: errorDetails }
        };
    }
};

// api/search/index.js

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

        // KORRIGIERTE SUCHOPTIONEN: Nur Semantische Rangfolge mit sicherem Sprachcode
        const searchOptions = {
            top: 5,
            includeTotalCount: true,
            
            // 1. Semantische Rangfolge aktivieren
            queryType: "semantic", 
            
            // 2. Den exakten Namen Ihrer Semantik-Konfiguration
            semanticConfiguration: "rag-1765009892742-semantic-configuration", 
            
            // 3. KORREKTUR: Sicherer Sprachcode für Deutsch
            queryLanguage: "de", 
            
            // 4. Verbesserte Rückgabe für LLM-Kontext
            captions: "extractive", 
            answers: "extractive|count-1" 
        };

        const resultsIterator = await client.search(query, searchOptions);

        const results = [];
        const semanticAnswers = resultsIterator.semanticAnswers || [];

        for await (const r of resultsIterator.results) {
            const caption = r.captions?.[0]?.text || null; 
            
            results.push({
                score: r.score,
                caption: caption,
                document: r.document
            });
        }

        context.log("Anzahl Treffer:", results.length);

        // Antworttext fürs Frontend bauen
        let answerText = "";

        if (results.length === 0) {
            answerText = "Ich habe leider keine passenden Dokumente gefunden.";
        } else {
            // Versuche, die beste semantische Antwort zu verwenden (falls gefunden)
            if (semanticAnswers.length > 0 && semanticAnswers[0].highlights) {
                answerText = `Beste semantische Antwort: ${semanticAnswers[0].highlights}`;
            } else {
                // Fallback auf den besten Dokumentenausschnitt (Caption oder Chunk)
                const firstResult = results[0];
                const firstDoc = firstResult.document;
                
                // Titel-Feld: Wir nutzen das im Index vorhandene 'title' Feld
                const title = firstDoc.title || firstDoc.fileName || "Gefundenes Dokument";

                // Verwende die Semantic Caption, wenn verfügbar, sonst den Chunk
                const contentSnippet = 
                    firstResult.caption || 
                    firstDoc.chunk || 
                    "Kein Ausschnitt verfügbar";
                
                answerText =
                    `Ich habe folgendes Dokument gefunden:\n\n` +
                    `Titel: ${title}\n\nAusschnitt:\n${contentSnippet.toString().slice(0, 800)}`;
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
                semanticAnswers: semanticAnswers, 
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


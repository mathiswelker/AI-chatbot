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

        // NEUE SUCHOPTIONEN: Hybrid-Suche und Semantische Rangfolge aktiviert
        const searchOptions = {
            top: 5,
            includeTotalCount: true,
            
            // 1. HYBRID SUCHE: Vektor-Abfrage für das 'text_vector'-Feld definieren
            vectors: [{
                value: query, // Die Benutzerabfrage wird hier zur Vektorisierung genutzt
                kNearestNeighborsCount: 50, 
                fields: ["text_vector"], // Ihr Vektorfeld
                vectorizableFields: [{ 
                    name: "text_vector", 
                    kNearestNeighborsCount: 50, 
                    // EINGEFÜGT: Ihr Vektor-Konfigurationsname
                    vectorConfig: "rag-1765009892742-azureOpenAi-text-profile"
                }]
            }],
            
            // 2. SEMANTISCHE RANGFOLGE: Aktivierung des Semantic Rankers
            queryType: "semantic", 
            // EINGEFÜGT: Ihr Semantik-Konfigurationsname
            semanticConfiguration: "rag-1765009892742-semantic-configuration", 
            queryLanguage: "de-de", 
            
            // 3. VERBESSERTE RÜCKGABE: Liefert die relevantesten Textausschnitte
            captions: "extractive", 
            answers: "extractive|count-1",
            
            // 4. Ausgewählte Felder: Nur die benötigten Felder abrufen
            select: ["chunk_id", "title", "chunk", "parent_id"] 
        };

        const resultsIterator = await client.search(query, searchOptions);

        const results = [];
        // NEU: Hinzufügen der Semantic Answers zu den Ergebnissen
        const semanticAnswers = resultsIterator.semanticAnswers || [];

        for await (const r of resultsIterator.results) {
            // Holen Sie sich die Semantic Caption, falls vorhanden
            const caption = r.captions?.[0]?.text || null; 
            
            results.push({
                score: r.score,
                caption: caption, // Fügen Sie die Caption hinzu
                document: r.document
            });
        }

        context.log("Anzahl Treffer:", results.length);
        context.log("Semantische Antworten gefunden:", semanticAnswers.length);

        // Antworttext fürs Frontend bauen
        let answerText = "";

        if (results.length === 0) {
            answerText = "Ich habe leider keine passenden Dokumente gefunden.";
        } else {
            // NEU: Versuche, die beste semantische Antwort zu verwenden (falls gefunden)
            if (semanticAnswers.length > 0 && semanticAnswers[0].highlights) {
                // Verwende die Highlighted Answer als beste Antwort
                answerText = `Beste semantische Antwort: ${semanticAnswers[0].highlights}`;
            } else {
                // Fallback auf den besten Dokumentenausschnitt (Caption oder Chunk)
                const firstResult = results[0];
                const firstDoc = firstResult.document;
                
                // Wir verwenden das 'title'-Feld, das Sie im Index haben
                const title = firstDoc.title || "Gefundenes Dokument";

                // Verwende die Semantic Caption, wenn verfügbar, sonst den Chunk
                const contentSnippet = 
                    firstResult.caption || 
                    firstDoc.chunk || 
                    "Kein Ausschnitt verfügbar";
                
                answerText =
                    `Ich habe folgendes Dokument gefunden:\n\n` +
                    `Titel: ${title}\n\nAusschnitt:\n${contentSnippet.toString().slice(0, 400)}`;
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

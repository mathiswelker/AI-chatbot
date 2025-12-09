// api/search/index.js

const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");

module.exports = async function (context, req) {
    context.log("HTTP trigger 'search' processed a request.");

    try {
        // 1) Query vom Frontend
        const query = req.body?.query || req.query?.q;
        if (!query) {
            context.res = {
                status: 400,
                body: { error: "Missing 'query' in request body." }
            };
            return;
        }

        // Begrüßungstext, der immer am Anfang der Antwort stehen soll
        const introText =
            "Hallo, um Ihnen schnellstmöglich Auskunft geben zu können, benötige ich folgende Informationen: Fehlercode und Hersteller der Maschine.";

        // 2) ENV Variablen
        const searchEndpoint = process.env.SEARCH_ENDPOINT;
        const searchKey = process.env.SEARCH_KEY;
        const indexName = process.env.SEARCH_INDEX_RAG || process.env.SEARCH_INDEX;

        const aoaiEndpointRaw  = process.env.AZURE_OPENAI_ENDPOINT;         // z.B. https://xxx.openai.azure.com
        const aoaiKey          = process.env.AZURE_OPENAI_KEY;
        const aoaiDeployment   = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;  // chatbot-RAG-gpt
        const aoaiApiVersion   = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

        if (!searchEndpoint || !searchKey || !indexName) {
            context.log.error("Missing SEARCH_* env vars.");
            context.res = {
                status: 500,
                body: { error: "Search service not configured." }
            };
            return;
        }

        if (!aoaiEndpointRaw || !aoaiKey || !aoaiDeployment) {
            context.log.error("Missing AZURE_OPENAI_* env vars.");
            context.res = {
                status: 500,
                body: { error: "Azure OpenAI not configured." }
            };
            return;
        }

        // Trailing Slash entfernen, damit die URL sicher stimmt
        const aoaiEndpoint = aoaiEndpointRaw.replace(/\/+$/, "");

        context.log("Using search index:", indexName);

        // 3) Search Client
        const searchClient = new SearchClient(
            searchEndpoint,
            indexName,
            new AzureKeyCredential(searchKey)
        );

        const searchOptions = {
            top: 5,
            includeTotalCount: true,
            queryType: "semantic",
            semanticConfiguration: "rag-1765009892742-semantic-configuration",
            queryLanguage: "de",
            captions: "extractive",
            answers: "extractive|count-1"
        };

        const resultsIterator = await searchClient.search(query, searchOptions);

        const results = [];
        const semanticAnswers = resultsIterator.semanticAnswers || [];

        for await (const r of resultsIterator.results) {
            const caption = r.captions?.[0]?.text || null;
            results.push({
                score: r.score,
                caption,
                document: r.document
            });
        }

        context.log("Anzahl Treffer:", results.length);

        // 4) Kontext für GPT aus Treffern bauen (Top 3)
        let contextText = "";
        if (results.length > 0) {
            const maxDocsForContext = 3;

            const parts = results.slice(0, maxDocsForContext).map((r, idx) => {
                const d = r.document;
                const title = d.title || d.fileName || `Dokument ${idx + 1}`;
                const text =
                    (r.caption || d.chunk || d.content || "")
                        .toString()
                        .slice(0, 1200);

                return `Quelle ${idx + 1} – ${title}:\n${text}`;
            });

            contextText = parts.join("\n\n");
        }

        // 5) GPT-Aufruf via fetch (Azure OpenAI REST API)
        let gptAnswer = null;

        if (contextText) {
            const url =
                `${aoaiEndpoint}/openai/deployments/${aoaiDeployment}` +
                `/chat/completions?api-version=${aoaiApiVersion}`;

            const messages = [
                {
                    role: "system",
                    content:
                        "Du bist ein technischer Assistent für Baumaschinen. " +
                        "Antworte kurz, klar und praxisnah auf Deutsch. " +
                        "Nutze ausschließlich den bereitgestellten Kontext. " +
                        "Wenn etwas nicht im Kontext steht, sage das offen."
                },
                {
                    role: "user",
                    content:
                        `Frage:\n${query}\n\n` +
                        `Kontext aus Handbüchern:\n${contextText}`
                }
            ];

            try {
                const gptResponse = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "api-key": aoaiKey
                    },
                    body: JSON.stringify({
                        messages,
                        temperature: 0.2
                    })
                });

                const gptBodyText = await gptResponse.text();

                if (!gptResponse.ok) {
                    context.log.error(
                        "Azure OpenAI error:",
                        gptResponse.status,
                        gptBodyText
                    );
                } else {
                    const gptJson = JSON.parse(gptBodyText);
                    gptAnswer =
                        gptJson.choices?.[0]?.message?.content?.trim() || null;
                }
            } catch (gptErr) {
                context.log.error("GPT call failed:", gptErr);
            }
        }

        // 6) Antwortlogik inkl. Fallback, falls nichts Konkretes im System ist
        let answerCore = "";

        // Kein konkreter Inhalt gefunden -> dein Kontakttext
        if (results.length === 0 || !contextText) {
            answerCore =
                "Leider ist im System nichts passendes hinterlegt. Bitte wenden Sie sich an folgenden Kontakt:\n\n" +
                "Max Mustermann, 0815-123456, ichweissnichtweiter@hilfmir.de";
        } else if (gptAnswer) {
            // GPT-Antwort vorhanden
            answerCore = gptAnswer;
        } else {
            // Fallback auf erstes Dokument
            const firstResult = results[0];
            const firstDoc = firstResult.document;

            const title = firstDoc.title || firstDoc.fileName || "Gefundenes Dokument";
            const contentSnippet =
                firstResult.caption ||
                firstDoc.chunk ||
                "Kein Ausschnitt verfügbar";

            answerCore =
                `Ich habe folgendes Dokument gefunden:\n\n` +
                `Titel: ${title}\n\nAusschnitt:\n${contentSnippet
                    .toString()
                    .slice(0, 800)}`;
        }

        // Begrüßungstext + eigentliche Antwort kombinieren
        const answerText = `${introText}\n\n${answerCore}`;

        // 7) Antwort ans Frontend
        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: {
                query,
                semanticAnswers,
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

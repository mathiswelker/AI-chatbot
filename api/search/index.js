// api/search/index.js

const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const OpenAI = require("openai");

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

        // 2) ENV Variablen
        const searchEndpoint = process.env.SEARCH_ENDPOINT;
        const searchKey = process.env.SEARCH_KEY;
        const indexName = process.env.SEARCH_INDEX_RAG || process.env.SEARCH_INDEX;

        const aoaiEndpoint   = process.env.AZURE_OPENAI_ENDPOINT;        // z.B. https://xxx.openai.azure.com/openai/v1/
        const aoaiKey        = process.env.AZURE_OPENAI_KEY;
        const aoaiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME; // chatbot-RAG-gpt

        if (!searchEndpoint || !searchKey || !indexName) {
            context.log.error("Missing SEARCH_* env vars.");
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

        // 4) Kontext aus Treffern für GPT bauen (Top 3)
        let contextText = "";
        if (results.length > 0) {
            const maxDocsForContext = 3;

            const parts = results.slice(0, maxDocsForContext).map((r, idx) => {
                const d = r.document;
                const title = d.title || d.fileName || `Dokument ${idx + 1}`;
                const text =
                    (r.caption || d.chunk || d.content || "")
                        .toString()
                        .slice(0, 1200); // begrenzen, damit Prompt nicht zu groß wird

                return `Quelle ${idx + 1} – ${title}:\n${text}`;
            });

            contextText = parts.join("\n\n");
        }

        // 5) GPT-Client (Azure OpenAI über OpenAI-SDK)
        const openai = new OpenAI({
            apiKey: aoaiKey,
            baseURL: aoaiEndpoint  // muss /openai/v1/ enthalten
        });

        let gptAnswer = null;

        if (contextText) {
            try {
                const completion = await openai.chat.completions.create({
                    // Wichtig: hier der Deployment-Name, nicht "gpt-4o-mini"
                    model: aoaiDeployment,
                    messages: [
                        {
                            role: "system",
                            content:
                                "Du bist ein technischer Assistent für Baumaschinen. " +
                                "Antworte immer kurz, klar und praxisnah auf Deutsch. " +
                                "Nutze ausschließlich den bereitgestellten Kontext. " +
                                "Wenn etwas nicht im Kontext steht, sage das offen."
                        },
                        {
                            role: "user",
                            content:
                                `Frage:\n${query}\n\n` +
                                `Kontext aus Handbüchern:\n${contextText}`
                        }
                    ],
                    temperature: 0.2
                });

                gptAnswer = completion.choices[0]?.message?.content?.trim() || null;
            } catch (gptErr) {
                context.log.error("GPT call failed:", gptErr);
            }
        }

        // 6) Fallback, falls GPT nichts liefert
        let answerText = "";

        if (results.length === 0) {
            answerText = "Ich habe leider keine passenden Dokumente gefunden.";
        } else if (gptAnswer) {
            answerText = gptAnswer;
        } else {
            const firstResult = results[0];
            const firstDoc = firstResult.document;

            const title = firstDoc.title || firstDoc.fileName || "Gefundenes Dokument";
            const contentSnippet =
                firstResult.caption ||
                firstDoc.chunk ||
                "Kein Ausschnitt verfügbar";

            answerText =
                `Ich habe folgendes Dokument gefunden:\n\n` +
                `Titel: ${title}\n\nAusschnitt:\n${contentSnippet
                    .toString()
                    .slice(0, 800)}`;
        }

        // 7) Antwort ans Frontend
        context.res = {
            status: 200,
            headers: {
                "Content-Type": "application/json"
            },
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

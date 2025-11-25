const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");

module.exports = async function (context, req) {
  try {
    const query = req.body?.query;
    if (!query) {
      context.res = {
        status: 400,
        body: { error: "Missing 'query' in request body." }
      };
      return;
    }

    // Environment variables
    const searchEndpoint = process.env.SEARCH_ENDPOINT;
    const searchKey = process.env.SEARCH_KEY;
    const indexName = process.env.SEARCH_INDEX;

    if (!searchEndpoint || !searchKey || !indexName) {
      context.log.error("Missing SEARCH_ENDPOINT / SEARCH_KEY / SEARCH_INDEX env var(s).");
      context.res = {
        status: 500,
        body: { error: "Search service not configured." }
      };
      return;
    }

    // Create client — pass plain strings (no ${} interpolation required)
    const client = new SearchClient(searchEndpoint, indexName, new AzureKeyCredential(searchKey));

    // Perform the search (limit results with top)
    const resultsIterator = await client.search(query, { top: 5 });

    const results = [];
    // resultsIterator.results is an async iterable of { score, document }
    for await (const r of resultsIterator.results) {
      results.push({
        score: r.score,
        document: r.document
      });
    }

    context.res = {
      status: 200,
      body: {
        query,
        results
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
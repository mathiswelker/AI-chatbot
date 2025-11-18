module.exports = async function (context, req) {
  const userMessage = req.body?.message || "Hello";
  
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: { message: You said: "${userMessage}" }
  };
};

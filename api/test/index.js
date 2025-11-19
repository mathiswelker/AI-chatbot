module.exports = async function (context, req) {
  const userMessage = req.body?.message || "";

  // Example: simple echo
  const reply = userMessage
    ? `Du hast gesagt: "${userMessage}"`
    : "Keine Nachricht erhalten";

  context.res = {
    status: 200,
    body: { reply }
  };
};

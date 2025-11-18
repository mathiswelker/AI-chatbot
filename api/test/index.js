module.exports = async function (context, req) {
  const userMessage = req.body?.message || "Hello";
  return {
    status: 200,
    body: { message: `You said: "${userMessage}"` },
  };
};

module.exports = async function (context, req) {
    context.log("API called");
    return {
        status: 200,
        body: { message: "Hello from /api/test" }
    };
};

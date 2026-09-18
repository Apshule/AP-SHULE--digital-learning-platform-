(function exposeApshuleApiBase(global) {
  const host = global.location.hostname.toLowerCase();
  const usesSameOriginApi =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".replit.dev") ||
    host.endsWith(".repl.co");

  global.APSHULE_API_BASE = usesSameOriginApi
    ? ""
    : "https://ap-shule-digital-learning-platform-3.onrender.com";
})(window);
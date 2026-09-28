(function exposeApshuleApiBase(global) {
  // The Skills frontend uses the Cloudflare Worker API at the production origin.
  global.APSHULE_API_BASE = "https://appshule.com";
})(window);
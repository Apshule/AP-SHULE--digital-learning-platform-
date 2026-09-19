(function (root) {
  "use strict";

  var translations = {
    English: {
      morning: "Good morning",
      afternoon: "Good afternoon",
      evening: "Good evening",
    },
    Luganda: {
      morning: "Wasuze otya",
      afternoon: "Osiibye otya",
      evening: "Osiibye otya akawungeezi",
    },
    Lusoga: {
      morning: "Wasuze otya",
      afternoon: "Osiibye otya",
      evening: "Osiibye otya akawungeezi",
    },
    Runyankore: {
      morning: "Oraire ota",
      afternoon: "Wasibye ota",
      evening: "Osiibwe ota",
    },
    Runyoro: {
      morning: "Oraire ota",
      afternoon: "Wasibye ota",
      evening: "Osiibwe ota",
    },
    Acholi: {
      morning: "Itye nining",
      afternoon: "Itye nining",
      evening: "Itye nining",
    },
    Swahili: {
      morning: "Habari za asubuhi",
      afternoon: "Habari za mchana",
      evening: "Habari za jioni",
    },
  };

  function asDate(value) {
    if (value instanceof Date) return value;
    var date = value === undefined ? new Date() : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function getGreetingKey(value) {
    var hour = asDate(value).getHours();
    if (hour < 12) return "morning";
    if (hour < 18) return "afternoon";
    return "evening";
  }

  function getGreeting(language, value) {
    var languagePack = translations[language] || translations.English;
    return languagePack[getGreetingKey(value)] || translations.English[getGreetingKey(value)];
  }

  function firstName(name, fallback) {
    var value = String(name || "").trim();
    if (!value) return fallback || "";
    return value.split(/\s+/)[0];
  }

  function formatGreeting(name, language, value, fallbackName) {
    var phrase = getGreeting(language, value);
    var person = firstName(name, fallbackName);
    return person ? phrase + ", " + person + "!" : phrase + "!";
  }

  var api = {
    translations: translations,
    getGreetingKey: getGreetingKey,
    getGreeting: getGreeting,
    firstName: firstName,
    formatGreeting: formatGreeting,
  };

  root.apshuleGreeting = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
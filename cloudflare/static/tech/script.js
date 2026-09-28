(function () {
  "use strict";

  var menuToggle = document.querySelector(".st-menu-toggle");
  var mainNav = document.querySelector(".st-main-nav");
  var navLinks = document.querySelectorAll(".st-main-nav a");

  if (menuToggle && mainNav) {
    menuToggle.addEventListener("click", function () {
      var isOpen = mainNav.classList.toggle("st-open");
      menuToggle.classList.toggle("st-open", isOpen);
      menuToggle.setAttribute("aria-expanded", String(isOpen));
    });
    navLinks.forEach(function (link) {
      link.addEventListener("click", function () {
        mainNav.classList.remove("st-open");
        menuToggle.classList.remove("st-open");
        menuToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      var href = this.getAttribute("href");
      if (!href || href === "#" || href === "#top") return;
      var target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  var contactForm = document.querySelector("#contact-form");
  var successBanner = document.querySelector(".st-form-success");
  var errorBanner = document.querySelector(".st-form-error");
  var submitButton = contactForm ? contactForm.querySelector('button[type="submit"]') : null;

  if (contactForm && successBanner && errorBanner && submitButton) {
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var originalText = submitButton.innerHTML;
      submitButton.disabled = true;
      submitButton.innerHTML = "Sending...";
      successBanner.hidden = true;
      errorBanner.hidden = true;
      var payload = Object.fromEntries(new FormData(contactForm).entries());

      fetch("/api/tech/contact", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Accept": "application/json", "Content-Type": "application/json" }
      })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data.ok) throw new Error(data.error || "We could not send your inquiry.");
          return data;
        });
      })
      .then(function () {
          contactForm.reset();
          successBanner.hidden = false;
          window.setTimeout(function () { successBanner.hidden = true; }, 8000);
      })
      .catch(function (error) {
        errorBanner.textContent = (error && error.message ? error.message : "Network error.") + " You can also contact us on WhatsApp: 0794221315.";
        errorBanner.hidden = false;
      })
      .finally(function () {
        submitButton.disabled = false;
        submitButton.innerHTML = originalText;
      });
    });
  }
}());

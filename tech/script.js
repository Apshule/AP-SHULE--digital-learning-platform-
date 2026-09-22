(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var redirectBanner = document.querySelector(".st-form-success");
  if (params.get("sent") === "1" && redirectBanner) {
    redirectBanner.hidden = false;
    window.setTimeout(function () { redirectBanner.hidden = true; }, 8000);
  }

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
  var submitButton = contactForm ? contactForm.querySelector('button[type="submit"]') : null;

  if (contactForm && successBanner && submitButton) {
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var originalText = submitButton.innerHTML;
      submitButton.disabled = true;
      submitButton.innerHTML = "Sending...";

      fetch(contactForm.action, {
        method: "POST",
        body: new FormData(contactForm),
        headers: { "Accept": "application/json" }
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.success) {
          contactForm.reset();
          successBanner.hidden = false;
          window.setTimeout(function () { successBanner.hidden = true; }, 8000);
        } else {
          alert("Something went wrong. Please try WhatsApp instead: 0794221315");
        }
      })
      .catch(function () {
        alert("Network error. Please try WhatsApp instead: 0794221315");
      })
      .finally(function () {
        submitButton.disabled = false;
        submitButton.innerHTML = originalText;
      });
    });
  }
}());

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

  if (contactForm && successBanner) {
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var data = Object.fromEntries(new FormData(contactForm).entries());
      console.log("Shule-Tech inquiry:", data);
      contactForm.reset();
      successBanner.hidden = false;
      window.setTimeout(function () { successBanner.hidden = true; }, 7000);
    });
  }
}());

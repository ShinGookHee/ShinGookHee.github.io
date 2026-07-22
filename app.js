const DRAFT_KEY = "gookhee-cv-draft";

async function loadResume() {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft) return JSON.parse(draft);
  const response = await fetch("resume.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load resume.json");
  return response.json();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function section(id, title, body) {
  return `
    <section class="container list-container" id="${escapeHtml(id)}">
      <h3>${escapeHtml(title)}</h3>
      ${body}
    </section>
  `;
}

function renderAbout(profile) {
  const about =
    profile.about ||
    profile.headline ||
    "Industrial and Systems Engineering student at KAIST.";

  return section(
    "about-me",
    "About Me",
    `
      <div class="row about-row">
        <div class="details profile-visual no-print">
          <img class="profile-img" src="images/profile.jpg" alt="Gookhee Shin profile photo" />
        </div>
        <div class="content">
          <p>${escapeHtml(about)}</p>
          ${
            profile.headline && profile.about
              ? `<p class="muted">${escapeHtml(profile.headline)}</p>`
              : ""
          }
        </div>
      </div>
    `,
  );
}

function renderEducation(education = []) {
  const rows = education
    .map((item) => {
      const degreeRows = [
        item.degree ? `<p>${escapeHtml(item.degree)}</p>` : "",
        item.minor ? `<p>${escapeHtml(item.minor)}</p>` : "",
        item.honors?.length
          ? `<ul>${item.honors.map((honor) => `<li>${escapeHtml(honor)}</li>`).join("")}</ul>`
          : "",
      ].join("");

      return `
        <div class="row layout">
          <div class="details">
            <h4>${escapeHtml(item.institution)}</h4>
            <p>${escapeHtml(item.date || "")}</p>
            ${item.location ? `<p>${escapeHtml(item.location)}</p>` : ""}
          </div>
          <div class="content">
            ${degreeRows}
          </div>
        </div>
      `;
    })
    .join("");

  return section("education", "Education", rows);
}

function renderEntry(item) {
  return `
    <div class="row layout">
      <div class="details">
        <h4>${escapeHtml(item.name)}</h4>
        <p>${escapeHtml(item.date || "")}</p>
        ${item.location ? `<p>${escapeHtml(item.location)}</p>` : ""}
      </div>
      <div class="content">
        ${item.role ? `<p><em>${escapeHtml(item.role)}</em></p>` : ""}
        ${
          item.bullets?.length
            ? `<ul>${item.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
            : ""
        }
      </div>
    </div>
  `;
}

function renderSectionGroup(group) {
  const slug = group.title
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return section(slug, group.title, group.items.map(renderEntry).join(""));
}

function renderAwards(awards = []) {
  if (!awards.length) return "";
  const rows = awards
    .map(
      (award) => `
        <div class="row layout">
          <div class="details">
            <h4>${escapeHtml(award.organization || award.name)}</h4>
            <p>${escapeHtml(award.date || "")}</p>
          </div>
          <div class="content">
            <p><strong>${escapeHtml(award.name)}</strong></p>
            ${award.description ? `<p>${escapeHtml(award.description)}</p>` : ""}
          </div>
        </div>
      `,
    )
    .join("");

  return section("awards-honors", "Awards & Honors", rows);
}

function renderSkills(skills = {}) {
  const rows = Object.entries(skills)
    .map(
      ([label, value]) => `
        <div class="row layout compact">
          <div class="details">
            <h4>${escapeHtml(label)}</h4>
          </div>
          <div class="content">
            <p>${escapeHtml(value)}</p>
          </div>
        </div>
      `,
    )
    .join("");

  return section("additional-information", "Additional Information", rows);
}

function orderedSections(sections = []) {
  const order = [
    "Research Experience",
    "Entrepreneurship & Startup Experience",
    "Investment & Industry Analysis",
    "Leadership & Teaching Experience",
  ];

  return [
    ...order.map((title) => sections.find((group) => group.title === title)).filter(Boolean),
    ...sections.filter((group) => !order.includes(group.title)),
  ];
}

function downloadJson(resume) {
  const blob = new Blob([JSON.stringify(resume, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "resume.json";
  link.click();
  URL.revokeObjectURL(url);
}

function renderResume(resume) {
  document.getElementById("cv").innerHTML = [
    renderAbout(resume.profile),
    renderEducation(resume.education),
    orderedSections(resume.sections).map(renderSectionGroup).join(""),
    renderAwards(resume.awards),
    renderSkills(resume.skills),
  ].join("");
}

loadResume()
  .then((resume) => {
    renderResume(resume);
    document.getElementById("downloadJson")?.addEventListener("click", () => downloadJson(resume));
  })
  .catch((error) => {
    document.getElementById("cv").innerHTML = `<section class="container"><p class="error">${escapeHtml(error.message)}</p></section>`;
  });

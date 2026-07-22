# Gookhee Shin_CV

Static GitHub Pages-ready academic CV website.

## Files

- `index.html`: public CV page
- `editor.html`: browser-based JSON editor
- `resume.json`: resume content
- `style.css`: academic website and editor styling
- `app.js`, `editor.js`: renderer and editor logic

The public version intentionally excludes sensitive private details.

## Local Preview

```bash
python3 -m http.server 8123
```

Then open:

```text
http://localhost:8123
```

## GitHub Pages

1. Create a public GitHub repository named `Gookhee-Shin_CV`.
2. Upload all files in this folder to the repository root.
3. In GitHub, go to `Settings > Pages`.
4. Set `Source` to `Deploy from a branch`.
5. Select `main` and `/root`.
6. Open the published URL. It will look like `https://YOUR_GITHUB_ID.github.io/Gookhee-Shin_CV/`.

For a root personal page like `https://YOUR_GITHUB_ID.github.io/`, the repository must be named `YOUR_GITHUB_ID.github.io`.

## Editing

Open `editor.html`, edit the JSON, save it in the browser, and download the updated `resume.json`.
Replace the repository's `resume.json` with the downloaded file and commit.

# The Bridge Table

Simple static site for the Panchshil Towers Bridge Club. The site:
- Renders results tables and a masterpoints table from CSV files.
- Loads some sections (training, gallery) as HTML partials.
- Uses Bootstrap, Bootstrap Icons, GLightbox and WOW.js for UI.

## Important files
- `index.html` — main page (located at project root)
- `assets/js/load_sort_tables.js` — main loader / sorting script (called from index.html)
- `assets/js/sort_table.js` — (if present) table sorting / CSV loading helpers
- `mps.csv` — data for the Masterpoints table (place next to index.html unless code expects a different path)
- `results.csv` — data for results tables (place next to index.html unless code expects a different path)
- `training_partial.html`, `gallery_partial.html` — partial HTML sections (place next to index.html)
- `.gitignore` — currently ignores `assets/fonts/`, `assets/gallery/`, `assets/images/` and other common files

## Author

Rajnesh Kathuria
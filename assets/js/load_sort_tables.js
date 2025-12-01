let currentSortColumn = '';
let currentSortOrder = '';
let tableData = [];

// Load CSV data when page loads
document.addEventListener('DOMContentLoaded', function() {
    loadTableData();
    loadResultsData();
    loadTrainingSection();
});

function loadTableData() {
    fetch('mps.csv')
        .then(response => response.text())
        .then(data => {
            // Parse CSV data
            const rows = data.split('\n');
            // Skip header row
            for(let i = 1; i < rows.length; i++) {
                if(rows[i].trim() !== '') {
                    const columns = rows[i].split(',');
                    tableData.push({
                        member: columns[0],
                        ytd: columns[1],
                        total: columns[2]
                    });
                }
            }
            // Initial population of table
            populateTable(tableData);
        })
        .catch(error => console.error('Error loading the CSV file:', error));
}

function populateTable(data) {
    const tbody = document.querySelector('#mps tbody');
    tbody.innerHTML = ''; // Clear existing rows

    data.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <th scope="row">${row.member}</th>
            <td>${row.ytd}</td>
            <td>${row.total}</td>
        `;
        tbody.appendChild(tr);
    });
}

function loadResultsData() {
    fetch('results.csv')
        .then(response => response.text())
        .then(data => {
            // Parse CSV data
            const rows = data.split('\n');
            const resultsData = {};
            
            // Skip header row and process data
            for(let i = 1; i < rows.length; i++) {
                if(rows[i].trim() !== '') {
                    const columns = rows[i].split(',');
                    const tournament = columns[0];
                    
                    // Create array for tournament if it doesn't exist
                    if (!resultsData[tournament]) {
                        resultsData[tournament] = [];
                    }
                    
                    // Add row data to tournament array
                    resultsData[tournament].push({
                        place: columns[1],
                        percent: columns[2],
                        score: columns[3],
                        ptmps: columns[4],
                        pair: columns[5]
                    });
                }
            }
            
            // Populate all results tables
            populateResultsTables(resultsData);
        })
        .catch(error => console.error('Error loading the results CSV file:', error));
}

function populateResultsTables(data) {
    // Find all tournament header elements
    const headers = document.querySelectorAll('#results h4.title');
    
    headers.forEach(header => {
        const tournamentName = header.textContent.trim();
        
        // Find the next table element after the header
        let el = header.nextElementSibling;
        while (el && el.tagName !== 'TABLE') {
            el = el.nextElementSibling;
        }
        const tableElement = el;
        if (!tableElement) return;

        if (tableElement && data[tournamentName]) {
            const tbody = tableElement.querySelector('tbody');
            tbody.innerHTML = ''; // Clear existing rows
            
            // Add rows for this tournament
            data[tournamentName].forEach(row => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <th scope="row">${row.place}</th>
                    <td>${row.percent}</td>
                    <td>${row.score}</td>
                    <td>${row.ptmps}</td>
                    <td>${row.pair}</td>
                `;
                tbody.appendChild(tr);
            });
        }
    });
}

function loadTrainingSection() {
    fetch('training_partial.html')
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.text();
        })
        .then(html => {
            // Find where to insert the training section (after results section)
            const resultsSection = document.getElementById('results');
            if (resultsSection) {
                // Create a temporary container
                const temp = document.createElement('div');
                temp.innerHTML = html;
                
                // Insert the training section after results
                resultsSection.insertAdjacentHTML('afterend', html);
                
                // Reinitialize WOW.js animations for the newly added content
                if (typeof WOW !== 'undefined') {
                    new WOW().init();
                }
            }
        })
        .catch(error => {
            console.error('Error loading training section:', error);
        });
}

function sortTable(columnIndex, tableId, sort_type = 'alpha') {
    const table = document.getElementById(tableId);
    const headers = table.getElementsByTagName('th');
    const tbody = table.getElementsByTagName('tbody')[0];
    const rows = tbody.getElementsByTagName('tr');
    const rowsArray = Array.from(rows);

    // Remove existing arrow icons
    for (let header of headers) {
        header.querySelector('i')?.remove();
    }

    // Add arrow icon to clicked header
    const header = headers[columnIndex];
    const arrow = document.createElement('i');
    
    if (currentSortColumn === columnIndex) {
        currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        currentSortOrder = columnIndex === 0 ? 'asc' : 'desc';
    }
    
    arrow.className = `bi bi-arrow-${currentSortOrder === 'asc' ? 'up' : 'down'} ms-1`;
    header.appendChild(arrow);

    currentSortColumn = columnIndex;

    rowsArray.sort((a, b) => {
        const aValue = a.cells[columnIndex].textContent.trim();
        const bValue = b.cells[columnIndex].textContent.trim();

        if (sort_type === 'alpha') {
            // Sort alphabetically
            return currentSortOrder === 'asc' 
                ? aValue.localeCompare(bValue)
                : bValue.localeCompare(aValue);
        } else {
            // Sort numerically
            return currentSortOrder === 'asc'
                ? Number(aValue) - Number(bValue)
                : Number(bValue) - Number(aValue);
        }
    });

    // Clear and re-append sorted rows
    while (tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
    }
    rowsArray.forEach(row => tbody.appendChild(row));
}
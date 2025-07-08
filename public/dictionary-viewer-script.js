let currentPage = 1;
let currentSearchTerm = '';
let currentLetter = '';
let totalPages = 1;
let expandedEntryId = null;

async function searchDictionary() {
    const searchTerm = document.getElementById('searchInput').value.trim();
    if (!searchTerm) {
        clearSearch();
        return;
    }
    currentSearchTerm = searchTerm;
    currentLetter = '';
    currentPage = 1;
    expandedEntryId = null;
    document.querySelectorAll('.alphabet-bar button.active').forEach(b => b.classList.remove('active'));
    await loadEntries();
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    currentSearchTerm = '';
    currentLetter = '';
    currentPage = 1;
    expandedEntryId = null;
    document.querySelectorAll('.alphabet-bar button.active').forEach(b => b.classList.remove('active'));
    loadEntries();
}

async function browseByLetter(letter) {
    currentLetter = letter;
    currentSearchTerm = '';
    currentPage = 1;
    expandedEntryId = null;
    document.getElementById('searchInput').value = '';
    document.querySelectorAll('.alphabet-bar button').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === letter);
    });
    await loadEntries();
}

async function loadEntries() {
    const entriesDiv = document.getElementById('dictionaryEntries');
    entriesDiv.innerHTML = '<div class="loading">Loading...</div>';
    try {
        // --- FIX: Point to the correct viewer route ---
        let url = `/dictionary/search?page=${currentPage}`;
        if (currentSearchTerm) {
            const searchLang = document.getElementById('searchType').value;
            url += `&term=${encodeURIComponent(currentSearchTerm)}&lang=${searchLang}`;
        } else if (currentLetter) {
            url += `&letter=${currentLetter}`;
        }
        
        const response = await fetch(url);
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Server error');
        }
        const data = await response.json();
        
        displayEntries(data.entries);
        updatePagination(data.totalPages, data.currentPage);
        updateResultsInfo(data.totalEntries);
        
    } catch (error) {
        entriesDiv.innerHTML = `<div class="no-results">Error loading entries: ${error.message}</div>`;
    }
}

function displayEntries(entries) {
    const entriesDiv = document.getElementById('dictionaryEntries');
    if (!entries || entries.length === 0) {
        entriesDiv.innerHTML = '<div class="no-results">No entries found.</div>';
        return;
    }
    entriesDiv.innerHTML = entries.map(entry => createEntryHTML(entry)).join('');
}

function createEntryHTML(entry) {
    const isExpanded = expandedEntryId === entry.id;
    const translationPreview = entry.translations.slice(0, 3).map(t => t.term).join(', ') + (entry.translations.length > 3 ? '...' : '');
    const formatNotes = (notes) => notes ? notes.replace(/\n/g, '<br>').replace(/---/g, '<hr class="note-separator">') : '';

    return `
        <div class="entry ${isExpanded ? 'expanded' : ''}" data-entry-id="${entry.id}">
            <div class="entry-header" onclick="toggleEntry('${entry.id}')">
                <span class="headword">${entry.headword}</span>
                ${entry.partOfSpeech ? `<span class="part-of-speech">${entry.partOfSpeech}</span>` : ''}
                ${entry.senseNumber ? `<span class="sense-number">Sense ${entry.senseNumber}</span>` : ''}
            </div>
            ${!isExpanded && translationPreview ? `<div class="translation-preview" onclick="toggleEntry('${entry.id}')">${translationPreview}</div>` : ''}
            <div class="entry-details">
                ${entry.germanDefinition ? `<div class="detail-section"><h4>Definition</h4><p>${entry.germanDefinition}</p></div>` : ''}
                ${entry.ahrhammarNotes ? `<div class="detail-section"><h4>Usage Notes (Ahrhammar)</h4><p>${formatNotes(entry.ahrhammarNotes)}</p></div>` : ''}
                ${entry.krogmannInfo ? `<div class="detail-section"><h4>Additional Info (Krogmann)</h4><p>${formatNotes(entry.krogmannInfo)}</p></div>` : ''}
                ${entry.krogmannIdioms ? `<div class="detail-section"><h4>Idioms (Krogmann)</h4><p>${formatNotes(entry.krogmannIdioms)}</p></div>` : ''}
                ${createTranslationsHTML(entry.translations)}
                ${createExamplesHTML(entry.examples)}
                ${createRelationsHTML(entry.relations)}
                ${createCitationsHTML(entry.citations)}
            </div>
        </div>
    `;
}

function createTranslationsHTML(translations) {
    if (!translations || translations.length === 0) return '';
    return `<div class="detail-section"><h4>Halunder Translations</h4>${translations.map(trans => `<div class="translation-item"><span class="hal-term">${trans.term}</span> ${trans.pronunciation ? `<span class="pronunciation">[${trans.pronunciation}]</span>` : ''} ${trans.gender ? `<span class="gender ${trans.gender}">${trans.gender}</span>` : ''} ${trans.plural ? `<span class="plural">pl. ${trans.plural}</span>` : ''} ${trans.note ? `<div class="translation-note">${trans.note}</div>` : ''} ${trans.etymology ? `<div class="etymology">Etymology: ${trans.etymology}</div>` : ''} ${trans.alternativeForms && trans.alternativeForms.length > 0 ? `<div class="alternative-forms">Alt: ${trans.alternativeForms.join(', ')}</div>` : ''} ${trans.sources ? `<div class="sources">Sources: ${trans.sources.join(', ')}</div>` : ''}</div>`).join('')}</div>`;
}

function createExamplesHTML(examples) {
    if (!examples || examples.length === 0) return '';
    return `<div class="detail-section"><h4>Examples</h4>${examples.map(ex => `<div class="example-item">${ex.type ? `<span class="example-type">${ex.type}</span>` : ''} ${ex.halunder ? `<div class="example-hal">${ex.halunder}</div>` : ''} ${ex.german ? `<div class="example-de">"${ex.german}"</div>` : ''} ${ex.note ? `<div class="example-note">(${ex.note})</div>` : ''}</div>`).join('')}</div>`;
}

function createRelationsHTML(relations) {
    if (!relations || relations.length === 0) return '';
    return `<div class="detail-section relations"><h4>See also</h4>${relations.map(rel => `<span class="relation-item"><span class="relation-type">${rel.type}:</span> <a href="#" class="relation-link" onclick="searchForConcept(event, '${rel.targetId}', '${rel.targetTerm}')">${rel.targetTerm}</a> ${rel.note ? `<span>(${rel.note})</span>` : ''}</span>`).join('')}</div>`;
}

function createCitationsHTML(citations) {
    if (!citations || citations.length === 0) return '';
    return `<div class="detail-section citations"><h4>Source Citations</h4><ul>${citations.map(cit => `<li>${cit}</li>`).join('')}</ul></div>`;
}

function toggleEntry(entryId) {
    if (expandedEntryId === entryId) {
        expandedEntryId = null;
    } else {
        expandedEntryId = entryId;
    }
    document.querySelectorAll('.entry').forEach(entryEl => {
        entryEl.classList.toggle('expanded', entryEl.dataset.entryId === expandedEntryId);
    });
}

async function searchForConcept(event, conceptId, term) {
    event.stopPropagation();
    document.getElementById('searchInput').value = term;
    await searchDictionary();
    setTimeout(() => {
        const targetEntry = document.querySelector(`[data-entry-id="${conceptId}"]`);
        if (targetEntry) {
            if (!targetEntry.classList.contains('expanded')) {
                toggleEntry(conceptId);
            }
            targetEntry.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 200);
}

function updatePagination(total, current) {
    totalPages = total;
    currentPage = current;
    const paginationDiv = document.getElementById('pagination');
    if (total <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }
    let html = `<button onclick="goToPage(${current - 1})" ${current === 1 ? 'disabled' : ''}>Previous</button>`;
    let startPage = Math.max(1, current - 2);
    let endPage = Math.min(total, current + 2);
    if (startPage > 1) {
        html += `<button onclick="goToPage(1)">1</button>`;
        if (startPage > 2) html += `<span>...</span>`;
    }
    for (let i = startPage; i <= endPage; i++) {
        html += `<button onclick="goToPage(${i})" class="${i === current ? 'active' : ''}">${i}</button>`;
    }
    if (endPage < total) {
        if (endPage < total - 1) html += `<span>...</span>`;
        html += `<button onclick="goToPage(${total})">${total}</button>`;
    }
    html += `<button onclick="goToPage(${current + 1})" ${current === total ? 'disabled' : ''}>Next</button>`;
    paginationDiv.innerHTML = html;
}

function updateResultsInfo(total) {
    const infoDiv = document.getElementById('resultsInfo');
    if (currentSearchTerm) {
        infoDiv.textContent = `Found ${total.toLocaleString()} entries for "${currentSearchTerm}"`;
    } else if (currentLetter) {
        infoDiv.textContent = `Showing ${total.toLocaleString()} entries starting with "${currentLetter}"`;
    } else {
        infoDiv.textContent = `Showing the most recent entries`;
    }
}

async function goToPage(page) {
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    expandedEntryId = null;
    await loadEntries();
    window.scrollTo(0, 0);
}

window.onload = function() {
    loadEntries();
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            searchDictionary();
        }
    });
};

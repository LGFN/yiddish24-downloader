// options.js - Compatibility mode settings (default OFF), stored in chrome.storage.local

const checkbox = document.getElementById('compat');
const minMinutes = document.getElementById('minMinutes');
const minGroup = document.getElementById('minGroup');

// The length option only matters while compatibility mode is on
function syncEnabled() {
  minGroup.classList.toggle('off', !checkbox.checked);
  minMinutes.disabled = !checkbox.checked;
}

chrome.storage.local.get({ compatibilityMode: false, compatMinMinutes: 10 }, (settings) => {
  checkbox.checked = settings.compatibilityMode;
  minMinutes.value = settings.compatMinMinutes;
  syncEnabled();
});

checkbox.addEventListener('change', () => {
  syncEnabled();
  chrome.storage.local.set({ compatibilityMode: checkbox.checked });
});

minMinutes.addEventListener('change', () => {
  const value = Math.max(0, Math.floor(Number(minMinutes.value) || 0));
  minMinutes.value = value;
  chrome.storage.local.set({ compatMinMinutes: value });
});

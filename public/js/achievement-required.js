/* Achievement form requirements: category, date, title and details are mandatory. */
(function () {
  'use strict';

  const categories = [
    ['CLIENT_DELIVERY', 'Client Delivery'],
    ['QUALITY', 'Quality'],
    ['INITIATIVE', 'Initiative'],
    ['PROCESS_IMROVEMENT', 'Process Improvement'],
    ['CLIENT_APPRECIATION', 'Client Appreciation'],
    ['TEAM_SUPPORT', 'Team Support'],
    ['LEARNING', 'Learning'],
    ['OTHER', 'Other'],
  ];

  function enhanceAchievementModal() {
    const modal = document.getElementById('modal');
    if (!modal || !modal.querySelector('#aDate') || modal.querySelector('#aCategory')) return;

    const dateRow = modal.querySelector('#aDate').closest('.form-row');
    const emptyField = dateRow && dateRow.querySelector('.field:empty');
    if (emptyField) {
      emptyField.innerHTML = '<label for="aCategory">Category</label><select id="aCategory" required><option value="">Select category…</option>'
        + categories.map(([value, label]) => `<option value="${value}">${label}</option>`).join('') + '</select>';
    }

    const desc = modal.querySelector('#aDesc');
    if (desc) {
      const label = desc.closest('.field')?.querySelector('label');
      if (label) label.textContent = 'Details';
      desc.required = true;
    }
    modal.querySelector('#aDate')?.setAttribute('required', '');
    modal.querySelector('#aTitle')?.setAttribute('required', '');
  }

  const observer = new MutationObserver(enhanceAchievementModal);
  observer.observe(document.body, { childList: true, subtree: true });

  // The main SPA owns the submit handler. Add the selected category to its
  // achievement POST without changing any other API calls.
  const originalPost = window.api && window.api.post;
  if (originalPost) {
    window.api.post = function (path, body) {
      if (path === '/achievements') {
        const category = document.getElementById('aCategory')?.value || '';
        if (!category) return Promise.reject(new Error('Category is required'));
        body = Object.assign({}, body, { category });
      }
      return originalPost.call(this, path, body);
    };
  }
})();

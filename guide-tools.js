(function () {
  function slugify(value) {
    return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function uniqueId(base) {
    var candidate = base || 'section';
    var index = 2;
    while (document.getElementById(candidate)) {
      candidate = base + '-' + index;
      index += 1;
    }
    return candidate;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var article = document.querySelector('.public-page .wrap');
    if (!article || article.dataset.guideTools || !article.querySelector('h1')) return;

    var headings = Array.prototype.slice.call(article.querySelectorAll('h2')).filter(function (heading) {
      return !heading.closest('footer') && heading.textContent.trim();
    });
    if (headings.length < 3) return;

    article.dataset.guideTools = 'ready';
    headings.forEach(function (heading) {
      if (!heading.id) heading.id = uniqueId(slugify(heading.textContent));
    });

    var after = article.querySelector('.meta-line') || article.querySelector('.lead') || article.querySelector('h1');
    var tools = document.createElement('aside');
    tools.className = 'guide-tools';

    var copy = document.createElement('div');
    copy.className = 'guide-tools-copy';
    var title = document.createElement('strong');
    title.textContent = 'On this page';
    var intro = document.createElement('p');
    intro.textContent = 'Use the sections below to find the decision or study step that applies to you.';
    copy.appendChild(title);
    copy.appendChild(intro);

    var toc = document.createElement('ol');
    toc.className = 'guide-toc';
    headings.forEach(function (heading) {
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.href = '#' + heading.id;
      link.textContent = heading.textContent.trim();
      item.appendChild(link);
      toc.appendChild(item);
    });
    tools.appendChild(copy);
    tools.appendChild(toc);
    after.insertAdjacentElement('afterend', tools);

    var contextCta = document.createElement('aside');
    contextCta.className = 'guide-context-cta';
    var contextCopy = document.createElement('p');
    contextCopy.textContent = 'Use a few cited practice questions to find the domain you should revisit next.';
    var contextLink = document.createElement('a');
    contextLink.href = '/';
    contextLink.textContent = 'Try 3 questions free ->';
    contextCta.appendChild(contextCopy);
    contextCta.appendChild(contextLink);
    headings[Math.min(2, headings.length - 1)].insertAdjacentElement('beforebegin', contextCta);
  });
})();

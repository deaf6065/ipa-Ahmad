const ipaPicker = document.querySelector('#ipa-picker');
const zipPicker = document.querySelector('#zip-picker');
const uploadStatus = document.querySelector('#upload-status');
const statusMessage = document.querySelector('#status-message');
const progressValue = document.querySelector('#progress-value');
const uploadProgress = document.querySelector('#upload-progress');
const filesList = document.querySelector('#files-list');

document.querySelector('#upload-ipa').addEventListener('click', () => ipaPicker.click());
document.querySelector('#upload-zip').addEventListener('click', () => zipPicker.click());
document.querySelector('#refresh-files').addEventListener('click', loadFiles);
ipaPicker.addEventListener('change', () => uploadFile(ipaPicker, 'ipa'));
zipPicker.addEventListener('change', () => uploadFile(zipPicker, 'zip'));

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} بايت`;
  const units = ['كيلوبايت', 'ميغابايت', 'غيغابايت'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${new Intl.NumberFormat('ar', { maximumFractionDigits: 1 }).format(size)} ${units[index]}`;
}

function showStatus(message, percent = 0, error = false) {
  uploadStatus.hidden = false;
  statusMessage.textContent = message;
  statusMessage.style.color = error ? '#ff9d9d' : '';
  progressValue.textContent = `${percent}%`;
  uploadProgress.value = percent;
}

function uploadFile(picker, kind) {
  const file = picker.files?.[0];
  picker.value = '';
  if (!file) return;

  showStatus(`جارٍ رفع ${file.name}…`);
  const body = new FormData();
  body.append('file', file, file.name);
  const request = new XMLHttpRequest();
  request.open('POST', `/api/uploads/${kind}`);
  request.upload.addEventListener('progress', (event) => {
    if (event.lengthComputable) {
      const percent = Math.round((event.loaded / event.total) * 100);
      showStatus(percent === 100 ? 'اكتمل الرفع، جارٍ التحقق من الملف…' : `جارٍ رفع ${file.name}…`, percent);
    }
  });
  request.addEventListener('load', () => {
    let result;
    try {
      result = JSON.parse(request.responseText);
    } catch {
      showStatus('تعذر قراءة استجابة الخادم.', 0, true);
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      showStatus(result.error || 'فشل رفع الملف.', 0, true);
      return;
    }
    showStatus('تم رفع الملف والتحقق منه بنجاح.', 100);
    loadFiles();
  });
  request.addEventListener('error', () => showStatus('تعذر الاتصال بالخادم. تحقق من اتصالك وحاول مجدداً.', 0, true));
  request.addEventListener('abort', () => showStatus('تم إلغاء رفع الملف.', 0, true));
  request.send(body);
}

async function loadFiles() {
  filesList.replaceChildren(Object.assign(document.createElement('div'), {
    className: 'empty-state',
    textContent: 'جارٍ تحميل الملفات…',
  }));
  try {
    const response = await fetch('/api/files');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل الملفات.');
    if (data.files.length === 0) {
      filesList.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'empty-state',
        textContent: 'لا توجد ملفات مرفوعة حتى الآن.',
      }));
      return;
    }
    filesList.replaceChildren(...data.files.map(createFileRow));
  } catch (error) {
    filesList.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      textContent: error.message || 'تعذر الاتصال بالخادم.',
    }));
  }
}

function createFileRow(file) {
  const row = document.createElement('article');
  row.className = 'file-row';
  const main = document.createElement('div');
  main.className = 'file-main';
  const badge = document.createElement('span');
  badge.className = `file-kind${file.kind === 'zip' ? ' zip' : ''}`;
  badge.textContent = file.kind.toUpperCase();
  const details = document.createElement('div');
  details.className = 'file-info';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = file.name;
  name.title = file.name;
  const meta = document.createElement('div');
  meta.className = 'file-meta';
  const date = new Date(file.uploadedAt);
  const dateText = Number.isNaN(date.getTime()) ? file.uploadedAt : new Intl.DateTimeFormat('ar', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
  meta.textContent = `${formatSize(file.size)} · ${dateText}`;
  details.append(name, meta);
  main.append(badge, details);
  row.append(main);

  if (file.kind === 'zip') {
    const inspect = document.createElement('button');
    inspect.className = 'inspect-button';
    inspect.type = 'button';
    inspect.textContent = 'فك الضغط وفحص المشروع';
    inspect.addEventListener('click', () => inspectFile(file, row, inspect));
    row.append(inspect);
  }

  return row;
}

async function inspectFile(file, row, button) {
  button.disabled = true;
  button.textContent = 'جارٍ الفحص…';
  let reportElement = row.nextElementSibling;
  if (reportElement?.classList.contains('inspection-report')) reportElement.remove();
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/inspect`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'فشل فحص الأرشيف.');
    reportElement = document.createElement('div');
    reportElement.className = 'inspection-report';
    const summary = document.createElement('strong');
    summary.textContent = `اكتمل فك الضغط والفحص: ${result.report.fileCount} ملف، ${formatSize(result.report.extractedBytes)}.`;
    reportElement.append(summary);
    if (result.report.topLevel.length > 0) {
      const list = document.createElement('ul');
      for (const item of result.report.topLevel) {
        const listItem = document.createElement('li');
        listItem.textContent = item;
        list.append(listItem);
      }
      reportElement.append(list);
    }
    row.after(reportElement);
  } catch (error) {
    reportElement = document.createElement('div');
    reportElement.className = 'inspection-report';
    reportElement.textContent = error.message || 'تعذر فحص الأرشيف.';
    row.after(reportElement);
  } finally {
    button.disabled = false;
    button.textContent = 'فك الضغط وفحص المشروع';
  }
}

fetch('/api/config')
  .then((response) => response.json())
  .then((data) => { document.querySelector('#size-limit').textContent = formatSize(data.maxFileSize); })
  .catch(() => { document.querySelector('#size-limit').textContent = 'حسب إعدادات الخادم'; });

loadFiles();

// Global Modal helper
window.Modal = (function() {
  const $ = (sel)=>document.querySelector(sel);
  const header = $('#appModalHeader');
  const title  = $('#appModalTitle');
  const body   = $('#appModalBody');
  const closeX = $('#appModalCloseX');
  const okBtn  = $('#appModalOkBtn');
  const cancelBtn = $('#appModalCancelBtn');
  const closeBtn  = $('#appModalCloseBtn');

  function reset(headerClass, t, msg) {
    header.className = 'modal-header py-2 ' + (headerClass || '');
    title.textContent = t || 'Notice';
    body.textContent = typeof msg === 'string' ? msg : (msg || '');
    okBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    closeBtn.style.display = '';
  }

  function show() {
    // Bootstrap modal
    $('#appModal').classList.add('show'); // for quick paint
    $('#appModal').style.display = 'block';
    // Use jQuery bootstrap if present
    if (window.$ && window.$.fn && window.$('#appModal').modal) {
      window.$('#appModal').modal('show');
    }
  }

  function hide() {
    if (window.$ && window.$.fn && window.$('#appModal').modal) {
      window.$('#appModal').modal('hide');
    } else {
      $('#appModal').classList.remove('show');
      $('#appModal').style.display = 'none';
    }
  }

  function success(msg, t='Success') {
    reset('bg-success text-white', t, msg);
    show();
  }

  function error(msg, t='Failed') {
    reset('bg-danger text-white', t, msg);
    show();
  }

  // Promise-based confirm dialog
  function confirm({
    title='Confirm',
    message='Are you sure?',
    okText='OK',
    cancelText='Cancel',
    headerClass='bg-danger text-white',
    okClass='btn-danger',
  } = {}) {
    reset(headerClass, title, message);
    return new Promise(resolve => {
      okBtn.textContent = okText;
      okBtn.className = 'btn btn-sm ' + okClass;
      okBtn.style.display = '';
      cancelBtn.textContent = cancelText;
      cancelBtn.style.display = '';
      closeBtn.style.display = 'none';

      const onOk = ()=>{ cleanup(); resolve(true); };
      const onCancel = ()=>{ cleanup(); resolve(false); };

      okBtn.addEventListener('click', onOk, { once:true });
      cancelBtn.addEventListener('click', onCancel, { once:true });
      closeX.addEventListener('click', onCancel, { once:true });

      function cleanup() { hide(); }

      show();
    });
  }

  return { success, error, confirm };
})();

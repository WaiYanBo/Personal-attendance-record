const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const authStatus = document.getElementById('authStatus');
const todayDate = document.getElementById('todayDate');
const liveClock = document.getElementById('liveClock');
const statusMessage = document.getElementById('statusMessage');
const checkinButton = document.getElementById('checkinButton');
const checkoutButton = document.getElementById('checkoutButton');
const logoutButton = document.getElementById('logoutButton');
const checkinValue = document.getElementById('checkinValue');
const checkoutValue = document.getElementById('checkoutValue');
const hoursValue = document.getElementById('hoursValue');
const messageBox = document.getElementById('messageBox');

const STORAGE_KEY = 'attendance-web-token';
const state = {
  token: localStorage.getItem(STORAGE_KEY) || '',
  user: null,
  attendance: null,
  clockTimer: null,
};

function formatClock(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function setMessage(text, kind = 'info') {
  if (!text) {
    messageBox.className = 'toast hidden';
    messageBox.textContent = '';
    return;
  }

  messageBox.textContent = text;
  messageBox.className = `toast ${kind}`;
  window.clearTimeout(state.messageTimer);
  state.messageTimer = window.setTimeout(() => {
    messageBox.className = 'toast hidden';
  }, 4200);
}

function setSignedOutView() {
  loginScreen.classList.remove('hidden');
  dashboard.classList.add('hidden');
  authStatus.textContent = 'Signed out';
  document.title = 'Daily Attendance';
}

function setSignedInView(username) {
  loginScreen.classList.add('hidden');
  dashboard.classList.remove('hidden');
  authStatus.textContent = `Signed in as ${username}`;
  document.title = `Daily Attendance | ${username}`;
}

function updateClock() {
  liveClock.textContent = formatClock();
  todayDate.textContent = formatDate();
}

function renderAttendance(attendance) {
  state.attendance = attendance;

  if (!attendance) {
    statusMessage.textContent = 'Waiting for your first action.';
    checkinButton.disabled = false;
    checkoutButton.disabled = true;
    checkinValue.textContent = '--';
    checkoutValue.textContent = '--';
    hoursValue.textContent = '--';
    return;
  }

  todayDate.textContent = attendance.dateLabel || formatDate();
  checkinValue.textContent = attendance.checkIn || '--';
  checkoutValue.textContent = attendance.checkOut || '--';
  hoursValue.textContent = attendance.hoursWorked || '--';

  if (attendance.status === 'checked_in') {
    statusMessage.textContent = 'Checked in and waiting for checkout.';
    checkinButton.disabled = true;
    checkoutButton.disabled = false;
  } else if (attendance.status === 'completed') {
    statusMessage.textContent = 'Attendance completed for today.';
    checkinButton.disabled = true;
    checkoutButton.disabled = true;
  } else {
    statusMessage.textContent = 'Choose check in or checkout to start.';
    checkinButton.disabled = false;
    checkoutButton.disabled = true;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      Authorization: state.token ? `Bearer ${state.token}` : '',
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'Something went wrong.');
  }

  return data;
}

async function refreshSession() {
  if (!state.token) {
    setSignedOutView();
    return;
  }

  try {
    const data = await request('/api/session');
    state.user = data.user;
    setSignedInView(data.user.username);
    renderAttendance(data.attendance);

    if (data.ready === false) {
      setMessage(data.configurationError || 'Google Sheets is not configured yet.', 'error');
    } else {
      setMessage('Session restored on this browser.', 'success');
    }
  } catch (error) {
    localStorage.removeItem(STORAGE_KEY);
    state.token = '';
    state.user = null;
    setSignedOutView();
    setMessage(error.message, 'error');
  }
}

async function submitAttendance(action) {
  const button = action === 'checkin' ? checkinButton : checkoutButton;
  button.disabled = true;

  try {
    const data = await request(`/api/${action}`, { method: 'POST', body: '{}' });
    renderAttendance(data.attendance);
    setMessage(data.message, 'success');
  } catch (error) {
    setMessage(error.message, 'error');
    await refreshSession();
  } finally {
    if (state.attendance?.status === 'completed') {
      checkinButton.disabled = true;
      checkoutButton.disabled = true;
    } else if (state.attendance?.status === 'checked_in') {
      checkinButton.disabled = true;
      checkoutButton.disabled = false;
    }
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  try {
    const data = await request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    state.token = data.token;
    state.user = data.user;
    localStorage.setItem(STORAGE_KEY, data.token);
    setSignedInView(data.user.username);
    setMessage('Signed in successfully.', 'success');
    await refreshSession();
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

checkinButton.addEventListener('click', () => submitAttendance('checkin'));
checkoutButton.addEventListener('click', () => submitAttendance('checkout'));
logoutButton.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  state.token = '';
  state.user = null;
  state.attendance = null;
  setSignedOutView();
  renderAttendance(null);
  setMessage('Logged out from this browser.', 'success');
});

updateClock();
window.setInterval(updateClock, 1000);
refreshSession();

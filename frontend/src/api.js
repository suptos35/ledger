const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function handleResponse(res) {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const errorMsg = (data && data.error) || `Request failed with status ${res.status}`;
    throw new Error(errorMsg);
  }
  return data;
}

export const api = {
  // Accounts
  async getAccounts() {
    const res = await fetch(`${API_BASE}/accounts`);
    return handleResponse(res);
  },

  async getAccount(id) {
    const res = await fetch(`${API_BASE}/accounts/${id}`);
    return handleResponse(res);
  },

  async createAccount(name) {
    const res = await fetch(`${API_BASE}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return handleResponse(res);
  },

  // Entries
  async getEntries(accountId) {
    const res = await fetch(`${API_BASE}/accounts/${accountId}/entries`);
    return handleResponse(res);
  },

  async createEntry(accountId, { type, amount, description }) {
    const res = await fetch(`${API_BASE}/accounts/${accountId}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, amount, description }),
    });
    return handleResponse(res);
  },

  // Health
  async checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
};

// Utilities
export function formatCurrency(cents) {
  if (typeof cents !== 'number' || isNaN(cents)) return '$0.00';
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

export function formatDate(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString.endsWith('Z') ? isoString : `${isoString}Z`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

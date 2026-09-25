import React, { useState, useEffect, useMemo } from 'react';
import { api, formatCurrency, formatDate } from './api';
import './App.css';

export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [entries, setEntries] = useState([]);
  const [isApiOnline, setIsApiOnline] = useState(false);
  const [loading, setLoading] = useState(true);

  // New Account Modal
  const [showNewAccountModal, setShowNewAccountModal] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [creatingAccount, setCreatingAccount] = useState(false);

  // Transfer Modal
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferToAccountId, setTransferToAccountId] = useState('');
  const [transferDollarAmount, setTransferDollarAmount] = useState('');
  const [transferDescription, setTransferDescription] = useState('');
  const [transferring, setTransferring] = useState(false);

  // Entry Form State
  const [entryType, setEntryType] = useState('credit');
  const [dollarAmount, setDollarAmount] = useState('');
  const [description, setDescription] = useState('');
  const [submittingEntry, setSubmittingEntry] = useState(false);

  // Entry Filters
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Toasts
  const [toasts, setToasts] = useState([]);

  const addToast = (type, message) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Check health and load accounts
  const loadAccounts = async () => {
    try {
      const data = await api.getAccounts();
      setAccounts(data);
      setIsApiOnline(true);
      if (data.length > 0 && !selectedAccountId) {
        setSelectedAccountId(data[0].id);
      }
    } catch (err) {
      console.error(err);
      setIsApiOnline(false);
    } finally {
      setLoading(false);
    }
  };

  // Load entries for selected account
  const loadEntries = async (accId) => {
    if (!accId) return;
    try {
      const data = await api.getEntries(accId);
      setEntries(data);
    } catch (err) {
      console.error(err);
      addToast('error', `Failed to load ledger: ${err.message}`);
    }
  };

  useEffect(() => {
    loadAccounts();
    const interval = setInterval(async () => {
      const online = await api.checkHealth();
      setIsApiOnline(online);
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadEntries(selectedAccountId);
    } else {
      setEntries([]);
    }
  }, [selectedAccountId]);

  const activeAccount = useMemo(() => {
    return accounts.find((a) => a.id === selectedAccountId) || null;
  }, [accounts, selectedAccountId]);

  // Statistics calculation for selected account
  const stats = useMemo(() => {
    let totalCredits = 0;
    let totalDebits = 0;
    for (const entry of entries) {
      if (entry.type === 'credit') {
        totalCredits += entry.amount;
      } else {
        totalDebits += entry.amount;
      }
    }
    return {
      totalCredits,
      totalDebits,
      count: entries.length,
    };
  }, [entries]);

  // Convert entered dollar string to cents
  const amountInCents = useMemo(() => {
    const parsed = parseFloat(dollarAmount);
    if (isNaN(parsed) || parsed <= 0) return 0;
    return Math.round(parsed * 100);
  }, [dollarAmount]);

  // Projected balance preview
  const projectedBalance = useMemo(() => {
    if (!activeAccount || amountInCents <= 0) return null;
    if (entryType === 'credit') {
      return activeAccount.balance + amountInCents;
    } else {
      return activeAccount.balance - amountInCents;
    }
  }, [activeAccount, entryType, amountInCents]);

  const isOverdraft = useMemo(() => {
    if (!activeAccount || entryType !== 'debit') return false;
    return amountInCents > activeAccount.balance;
  }, [activeAccount, entryType, amountInCents]);

  // Transfer calculations
  const transferAmountInCents = useMemo(() => {
    const parsed = parseFloat(transferDollarAmount);
    if (isNaN(parsed) || parsed <= 0) return 0;
    return Math.round(parsed * 100);
  }, [transferDollarAmount]);

  const isTransferOverdraft = useMemo(() => {
    if (!activeAccount) return false;
    return transferAmountInCents > activeAccount.balance;
  }, [activeAccount, transferAmountInCents]);

  const availableTransferDestinations = useMemo(() => {
    if (!activeAccount) return [];
    return accounts.filter((a) => a.id !== activeAccount.id);
  }, [accounts, activeAccount]);

  // Handlers
  const handleCreateAccount = async (e) => {
    e.preventDefault();
    if (!newAccountName.trim()) return;

    setCreatingAccount(true);
    try {
      const created = await api.createAccount(newAccountName.trim());
      setAccounts((prev) => [...prev, created]);
      setSelectedAccountId(created.id);
      setNewAccountName('');
      setShowNewAccountModal(false);
      addToast('success', `Account "${created.name}" created successfully.`);
    } catch (err) {
      addToast('error', err.message);
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleCreateEntry = async (e) => {
    e.preventDefault();
    if (!activeAccount) return;
    if (amountInCents <= 0) {
      addToast('error', 'Please enter a valid positive transaction amount.');
      return;
    }
    if (isOverdraft) {
      addToast('error', 'Cannot proceed: Debit amount exceeds available balance.');
      return;
    }

    setSubmittingEntry(true);
    try {
      const newEntry = await api.createEntry(activeAccount.id, {
        type: entryType,
        amount: amountInCents,
        description: description.trim() || undefined,
      });

      // Update active account balance in state
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === activeAccount.id ? { ...acc, balance: newEntry.balance_after } : acc
        )
      );

      // Reload entries to get refreshed running balances
      await loadEntries(activeAccount.id);

      setDollarAmount('');
      setDescription('');
      addToast(
        'success',
        `${entryType === 'credit' ? 'Deposit' : 'Withdrawal'} of ${formatCurrency(amountInCents)} recorded.`
      );
    } catch (err) {
      addToast('error', err.message);
    } finally {
      setSubmittingEntry(false);
    }
  };

  const handleTransfer = async (e) => {
    e.preventDefault();
    if (!activeAccount) return;
    const destId = parseInt(transferToAccountId, 10);
    if (!destId) {
      addToast('error', 'Please select a destination account.');
      return;
    }
    if (transferAmountInCents <= 0) {
      addToast('error', 'Please enter a valid transfer amount.');
      return;
    }
    if (isTransferOverdraft) {
      addToast('error', 'Transfer amount exceeds available balance.');
      return;
    }

    setTransferring(true);
    try {
      const res = await api.transferFunds({
        fromAccountId: activeAccount.id,
        toAccountId: destId,
        amount: transferAmountInCents,
        description: transferDescription.trim() || undefined,
      });

      // Update balances of both sender and recipient in state
      setAccounts((prev) =>
        prev.map((acc) => {
          if (acc.id === activeAccount.id) return { ...acc, balance: res.from_balance };
          if (acc.id === destId) return { ...acc, balance: res.to_balance };
          return acc;
        })
      );

      // Reload current account's entries
      await loadEntries(activeAccount.id);

      setTransferDollarAmount('');
      setTransferDescription('');
      setShowTransferModal(false);
      addToast('success', `Transfer of ${formatCurrency(transferAmountInCents)} completed.`);
    } catch (err) {
      addToast('error', err.message);
    } finally {
      setTransferring(false);
    }
  };

  // Filtered entries
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (filterType !== 'all' && entry.type !== filterType) return false;
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const descMatch = (entry.description || '').toLowerCase().includes(query);
        const amountMatch = (entry.amount / 100).toString().includes(query);
        return descMatch || amountMatch;
      }
      return true;
    });
  }, [entries, filterType, searchQuery]);

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon">TL</div>
          <div>
            <h1 className="brand-title">Mini Transaction Ledger</h1>
            <div className="brand-subtitle">Financial Integrity Engine</div>
          </div>
        </div>

        <div className="header-actions">
          <div className="api-status">
            <span className={`status-dot ${isApiOnline ? 'online' : 'offline'}`} />
            {isApiOnline ? 'API Connected' : 'API Offline'}
          </div>

          {availableTransferDestinations.length > 0 && activeAccount && (
            <button
              id="btn-open-transfer-modal"
              className="btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
              onClick={() => {
                setTransferToAccountId(availableTransferDestinations[0]?.id || '');
                setShowTransferModal(true);
              }}
            >
              <span>⇄</span> Transfer
            </button>
          )}

          <button
            id="btn-create-account-modal"
            className="btn-primary"
            onClick={() => setShowNewAccountModal(true)}
          >
            <span>+</span> New Account
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="main-layout">
        {/* Left Sidebar: Accounts */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <span className="sidebar-title">Accounts</span>
            <span className="account-count">{accounts.length}</span>
          </div>

          <div className="account-list">
            {loading ? (
              <div className="empty-sidebar">Loading accounts...</div>
            ) : accounts.length === 0 ? (
              <div className="empty-sidebar">
                <p>No accounts created yet.</p>
                <button
                  className="btn-primary"
                  style={{ marginTop: '1rem', width: '100%', justifyContent: 'center' }}
                  onClick={() => setShowNewAccountModal(true)}
                >
                  Create First Account
                </button>
              </div>
            ) : (
              accounts.map((acc) => (
                <div
                  key={acc.id}
                  id={`account-card-${acc.id}`}
                  className={`account-card ${selectedAccountId === acc.id ? 'active' : ''}`}
                  onClick={() => setSelectedAccountId(acc.id)}
                >
                  <div className="card-top">
                    <span className="account-name">{acc.name}</span>
                    <span className="account-id-badge">#{acc.id}</span>
                  </div>
                  <div className="card-bottom">
                    <span className="account-balance-label">Balance</span>
                    <span className="account-balance">{formatCurrency(acc.balance)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Right Detail: Selected Account Ledger */}
        <main className="detail-area">
          {!activeAccount ? (
            <div className="empty-detail-placeholder">
              <h2>Select an account to view its transaction ledger</h2>
              <p>Or create a new account using the button above.</p>
            </div>
          ) : (
            <>
              {/* Account Banner */}
              <section className="account-banner">
                <div className="banner-info">
                  <div className="banner-title-row">
                    <h2 className="banner-title">{activeAccount.name}</h2>
                    <span className="account-id-badge">Account #{activeAccount.id}</span>
                  </div>
                  <div className="banner-meta">
                    Created on {formatDate(activeAccount.created_at)}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }}>
                  <div className="banner-balance-box">
                    <span className="balance-box-label">Current Running Balance</span>
                    <span className="balance-box-val">{formatCurrency(activeAccount.balance)}</span>
                  </div>

                  {availableTransferDestinations.length > 0 && (
                    <button
                      className="btn-primary"
                      style={{ padding: '0.6rem 1rem', fontSize: '0.85rem' }}
                      onClick={() => {
                        setTransferToAccountId(availableTransferDestinations[0]?.id || '');
                        setShowTransferModal(true);
                      }}
                    >
                      ⇄ Transfer Funds
                    </button>
                  )}
                </div>
              </section>

              {/* Stats Grid */}
              <div className="stats-grid">
                <div className="stat-card">
                  <span className="stat-label">Total Deposits (Credits)</span>
                  <span className="stat-val credit">+{formatCurrency(stats.totalCredits)}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Total Withdrawals (Debits)</span>
                  <span className="stat-val debit">-{formatCurrency(stats.totalDebits)}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Total Transactions</span>
                  <span className="stat-val">{stats.count}</span>
                </div>
              </div>

              {/* Record Entry Form */}
              <section className="entry-form-card">
                <div className="form-header">
                  <h3 className="form-title">Record Transaction</h3>
                  <div className="type-toggle">
                    <button
                      type="button"
                      id="toggle-credit"
                      className={`type-btn ${entryType === 'credit' ? 'active credit' : ''}`}
                      onClick={() => setEntryType('credit')}
                    >
                      + Credit (Deposit)
                    </button>
                    <button
                      type="button"
                      id="toggle-debit"
                      className={`type-btn ${entryType === 'debit' ? 'active debit' : ''}`}
                      onClick={() => setEntryType('debit')}
                    >
                      - Debit (Withdrawal)
                    </button>
                  </div>
                </div>

                <form onSubmit={handleCreateEntry}>
                  <div className="form-grid">
                    <div className="form-group">
                      <label className="form-label" htmlFor="entry-amount">Amount (USD)</label>
                      <div className="amount-input-wrapper">
                        <span className="currency-prefix">$</span>
                        <input
                          id="entry-amount"
                          type="number"
                          step="0.01"
                          min="0.01"
                          placeholder="0.00"
                          className="form-input"
                          value={dollarAmount}
                          onChange={(e) => setDollarAmount(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label" htmlFor="entry-description">Description</label>
                      <input
                        id="entry-description"
                        type="text"
                        placeholder="e.g., Client payment, Groceries, Cloud invoice..."
                        className="form-input"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </div>

                    <button
                      type="submit"
                      id="btn-submit-entry"
                      className="btn-primary"
                      disabled={submittingEntry || isOverdraft || amountInCents <= 0}
                      style={{ height: '46px' }}
                    >
                      {submittingEntry ? 'Saving...' : 'Post Entry'}
                    </button>
                  </div>
                </form>

                {/* Projected Balance Preview & Overdraft Warning */}
                {amountInCents > 0 && (
                  <div className={`balance-preview-banner ${isOverdraft ? 'warning' : 'normal'}`}>
                    {isOverdraft ? (
                      <span>
                        ⚠️ <strong>Insufficient Balance:</strong> Maximum debit allowed is{' '}
                        {formatCurrency(activeAccount.balance)}.
                      </span>
                    ) : (
                      <span>
                        Projected balance after this {entryType}:{' '}
                        <strong>{formatCurrency(projectedBalance)}</strong>
                      </span>
                    )}
                  </div>
                )}
              </section>

              {/* Transactions Ledger */}
              <section className="entries-container">
                <div className="table-toolbar">
                  <h3 className="table-title">Transaction Ledger</h3>

                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder="Filter transactions..."
                      className="form-input"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />

                    <div className="filter-group">
                      <button
                        className={`filter-btn ${filterType === 'all' ? 'active' : ''}`}
                        onClick={() => setFilterType('all')}
                      >
                        All
                      </button>
                      <button
                        className={`filter-btn ${filterType === 'credit' ? 'active' : ''}`}
                        onClick={() => setFilterType('credit')}
                      >
                        Credits
                      </button>
                      <button
                        className={`filter-btn ${filterType === 'debit' ? 'active' : ''}`}
                        onClick={() => setFilterType('debit')}
                      >
                        Debits
                      </button>
                    </div>
                  </div>
                </div>

                <div className="table-card">
                  <table className="ledger-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Timestamp</th>
                        <th>Type</th>
                        <th>Description</th>
                        <th>Amount</th>
                        <th>Running Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEntries.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="empty-table">
                            No ledger entries found. Record your first credit or debit above.
                          </td>
                        </tr>
                      ) : (
                        filteredEntries.map((item) => (
                          <tr key={item.id} id={`entry-row-${item.id}`}>
                            <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                              #{item.id}
                            </td>
                            <td style={{ color: 'var(--text-muted)' }}>{formatDate(item.created_at)}</td>
                            <td>
                              <span className={`badge ${item.type}`}>{item.type}</span>
                            </td>
                            <td>{item.description || <span style={{ color: 'var(--text-dim)' }}>—</span>}</td>
                            <td className={`amount-cell ${item.type}`}>
                              {item.type === 'credit' ? '+' : '-'}
                              {formatCurrency(item.amount)}
                            </td>
                            <td className="balance-cell">{formatCurrency(item.running_balance)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </main>
      </div>

      {/* New Account Modal */}
      {showNewAccountModal && (
        <div className="modal-overlay" onClick={() => setShowNewAccountModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Create New Account</h3>
              <button
                className="modal-close"
                onClick={() => setShowNewAccountModal(false)}
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleCreateAccount}>
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label className="form-label" htmlFor="new-account-name">
                  Account Name
                </label>
                <input
                  id="new-account-name"
                  type="text"
                  placeholder="e.g., Primary Checking, Corporate Reserve..."
                  className="form-input"
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowNewAccountModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="btn-confirm-create-account"
                  className="btn-primary"
                  disabled={creatingAccount || !newAccountName.trim()}
                >
                  {creatingAccount ? 'Creating...' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Transfer Funds Modal */}
      {showTransferModal && activeAccount && (
        <div className="modal-overlay" onClick={() => setShowTransferModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Transfer Funds</h3>
              <button
                className="modal-close"
                onClick={() => setShowTransferModal(false)}
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleTransfer}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
                <div className="form-group">
                  <label className="form-label">From Account</label>
                  <input
                    type="text"
                    className="form-input"
                    value={`${activeAccount.name} (#${activeAccount.id}) - Available: ${formatCurrency(activeAccount.balance)}`}
                    disabled
                    style={{ opacity: 0.75 }}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="transfer-to-account">
                    To Destination Account
                  </label>
                  <select
                    id="transfer-to-account"
                    className="form-input"
                    value={transferToAccountId}
                    onChange={(e) => setTransferToAccountId(e.target.value)}
                    required
                  >
                    {availableTransferDestinations.map((dest) => (
                      <option key={dest.id} value={dest.id}>
                        {dest.name} (#{dest.id}) — Balance: {formatCurrency(dest.balance)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="transfer-amount">
                    Transfer Amount (USD)
                  </label>
                  <div className="amount-input-wrapper">
                    <span className="currency-prefix">$</span>
                    <input
                      id="transfer-amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      className="form-input"
                      value={transferDollarAmount}
                      onChange={(e) => setTransferDollarAmount(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="transfer-description">
                    Transfer Note / Description
                  </label>
                  <input
                    id="transfer-description"
                    type="text"
                    placeholder="e.g., Monthly savings, Invoice reimbursement..."
                    className="form-input"
                    value={transferDescription}
                    onChange={(e) => setTransferDescription(e.target.value)}
                  />
                </div>

                {transferAmountInCents > 0 && (
                  <div className={`balance-preview-banner ${isTransferOverdraft ? 'warning' : 'normal'}`}>
                    {isTransferOverdraft ? (
                      <span>
                        ⚠️ <strong>Insufficient Balance:</strong> You have{' '}
                        {formatCurrency(activeAccount.balance)} available.
                      </span>
                    ) : (
                      <span>
                        Origin balance after transfer:{' '}
                        <strong>{formatCurrency(activeAccount.balance - transferAmountInCents)}</strong>
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowTransferModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="btn-confirm-transfer"
                  className="btn-primary"
                  disabled={transferring || isTransferOverdraft || transferAmountInCents <= 0 || !transferToAccountId}
                >
                  {transferring ? 'Transferring...' : 'Execute Transfer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{t.type === 'success' ? '✓' : '⚠️'}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

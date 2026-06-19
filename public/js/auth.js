/**
 * auth.js — Client-side authentication module
 * Handles register, login, logout, token management, and auth guards.
 */

const API_BASE = "/api/auth";

/**
 * Register a new user
 */
export async function register(name, username, email, password) {
  const res = await fetch(`${API_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, username, email, password })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Registration failed.");
  }

  // Store token and user data
  localStorage.setItem("communit_token", data.token);
  localStorage.setItem("communit_user", JSON.stringify(data.user));

  return data;
}

/**
 * Log in an existing user
 */
export async function login(email, password) {
  const res = await fetch(`${API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Login failed.");
  }

  localStorage.setItem("communit_token", data.token);
  localStorage.setItem("communit_user", JSON.stringify(data.user));

  return data;
}

/**
 * Log out the current user
 */
export async function logout() {
  const token = getToken();

  if (token) {
    try {
      await fetch(`${API_BASE}/logout`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
    } catch (e) {
      // Proceed with local cleanup even if API call fails
    }
  }

  localStorage.removeItem("communit_token");
  localStorage.removeItem("communit_user");
  window.location.href = "/login.html";
}

/**
 * Get the stored JWT token
 */
export function getToken() {
  return localStorage.getItem("communit_token");
}

/**
 * Get the current user object
 */
export function getCurrentUser() {
  const raw = localStorage.getItem("communit_user");
  return raw ? JSON.parse(raw) : null;
}

/**
 * Auth guard — redirects to login if no token present
 */
export function authGuard() {
  if (!getToken()) {
    window.location.href = "/login.html";
    return false;
  }
  return true;
}

/**
 * Create an authenticated fetch wrapper
 */
export async function authFetch(url, options = {}) {
  const token = getToken();

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
    ...(token ? { "Authorization": `Bearer ${token}` } : {})
  };

  const res = await fetch(url, { ...options, headers });

  // If unauthorized, redirect to login
  if (res.status === 401) {
    localStorage.removeItem("communit_token");
    localStorage.removeItem("communit_user");
    window.location.href = "/login.html";
    return;
  }

  return res;
}

/**
 * Get user initials for avatar display
 */
export function getUserInitials(user) {
  if (!user) return "?";
  if (user.name) {
    return user.name
      .split(" ")
      .map(w => w[0])
      .join("")
      .toUpperCase()
      .substring(0, 2);
  }
  return user.username ? user.username[0].toUpperCase() : user.email[0].toUpperCase();
}

/**
 * Get resolved display name for user ID from localStorage mapping.
 */
export function getDisplayName(userId, fallbackName) {
  if (!userId) return fallbackName;
  try {
    const map = JSON.parse(localStorage.getItem("communit_display_names") || "{}");
    if (map[userId]) {
      return map[userId];
    }
  } catch (e) {}
  return fallbackName;
}

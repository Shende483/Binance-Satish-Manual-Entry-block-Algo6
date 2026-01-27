import axios, { type AxiosInstance } from 'axios';
import io from 'socket.io-client';

const API_BASE_URL = import.meta.env.VITE_API_URL;

const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  config.headers['X-Request-Timestamp'] = new Date().toISOString();
  return config;
});

export interface SignupData {
  email: string;
  mobile: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface LoginData {
  emailOrMobile: string;
  password: string;
}

let socket: any = null;

export const initializeSocket = (token: string, accountId: string) => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  socket = io(API_BASE_URL, {
    auth: { token, accountId, timestamp: new Date().toISOString() },
  });
  socket.on('connect', () => {
    console.log(`Socket.IO connected for account ${accountId}`);
  });
  socket.on('disconnect', () => {
    console.log(`Socket.IO disconnected for account ${accountId}`);
  });
  socket.on('auth-error', (response: { statusCode: number; message: string; success: boolean }) => {
    console.error(`[${new Date().toISOString()}] Auth error:`, response.message);
  });
  return socket;
};

export const getSocket = () => socket;

export const requestTradeHistory = (page = 1, limit = 10, symbol?: string) => {
  const s = getSocket();
  if (!s) throw new Error('Socket not connected');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('History timeout')), 10000);
    s.emit('get-trade-history', { page, limit, symbol, timestamp: new Date().toISOString() });

    s.once('trade-history-response', (resp: any) => {
      clearTimeout(timeout);
      console.log('Received trade history:', resp); // ← logs response
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
};

export const requestSymbolTodayEntries = (symbol: string) => {
  const s = getSocket();
  if (!s) throw new Error('Socket not connected');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 8000);
    s.emit('get-symbol-today-entries', { symbol, timestamp: new Date().toISOString() });
    s.once('symbol-today-entries-response', (resp: any) => {
      clearTimeout(timeout);
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
};

export const closePosition = async (
  symbol: string,
  type: 'BUY' | 'SELL',
  positionSide: string,
  volume: number
) => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket.IO not connected');
  return new Promise((resolve, reject) => {
    socket.emit('close-position', {
      symbol,
      type,
      positionSide,
      volume,
      timestamp: new Date().toISOString()
    });
    socket.once('close-position-response', (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
};

export const cancelOrder = async (clientOrderId: string) => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket.IO not connected');
  return new Promise((resolve, reject) => {
    socket.emit('cancel-order', { clientOrderId, timestamp: new Date().toISOString() });
    socket.once('cancel-order-response', (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
};

export const setBlockStatus = async (duration: number) => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket.IO not connected');
  return new Promise((resolve, reject) => {
    socket.emit('set-block-status', { duration, timestamp: new Date().toISOString() });
    socket.once('block-status-response', (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
};

export const activateBurstMode = async () => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket.IO not connected');
  return new Promise((resolve, reject) => {
    socket.emit('activate-burst', { timestamp: new Date().toISOString() });
    socket.once('burst-response', (response: any) => {
      if (response.reason) reject(new Error(response.reason));
      else resolve(response);
    });
  });
};

export const deactivateBurstMode = async () => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket.IO not connected');
  return new Promise((resolve, reject) => {
    socket.emit('deactivate-burst', { timestamp: new Date().toISOString() });
    socket.once('burst-response', (response: any) => {
      if (response.message && !response.success) reject(new Error(response.message));
      else resolve(response);
    });
  });
};

export const getsymbolsMode = async () => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket.IO not connected');
  return new Promise((resolve, reject) => {
    socket.emit('get-symbols', { timestamp: new Date().toISOString() });
    socket.once('symbols-response', (response: any) => {
      if (response.message && !response.success) reject(new Error(response.message));
      else resolve(response);
    });
  });
};

export const modifyOrder = async (payload: {
  symbol: string;
  orderId: string;
  positionAmt: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  oldPrice: number;
  lastupdate: number;
  newPrice: number;
  type: 'SL' | 'TP';
  clientId: string;
}) => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket not connected');
  return new Promise((resolve, reject) => {
    socket.emit('modify-order', { ...payload, timestamp: new Date().toISOString() });
    socket.once('modify-order-response', (resp: any) => {
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
};

export const addMargin = async (symbol: string, side: 'BUY' | 'SELL', amount: number) => {
  const socket = getSocket();
  if (!socket) throw new Error('Socket.IO not connected');
  return new Promise((resolve, reject) => {
    socket.emit('add-margin', { symbol, side, amount, timestamp: new Date().toISOString() });
    socket.once('add-margin-response', (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
};

export const signup = async (data: SignupData) => {
  const response = await api.post('/auth/signup', { ...data, timestamp: new Date().toISOString() });
  return response.data;
};

export const login = async (data: LoginData) => {
  const response = await api.post('/auth/login', { ...data, timestamp: new Date().toISOString() });
  return response.data;
};

export const verifyToken = async () => {
  const response = await api.get('/auth/verify-token', { headers: { 'X-Request-Timestamp': new Date().toISOString() } });
  return response.data;
};

export const logout = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  localStorage.removeItem('token');
};


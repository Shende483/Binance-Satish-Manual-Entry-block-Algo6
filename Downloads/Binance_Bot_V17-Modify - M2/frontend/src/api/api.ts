
// src/api/api.ts (FULL – with order-preflight & confirmOrder)
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
export interface OrderData {
  symbol: string;
  side: 'BUY' | 'SELL';
  stopLoss?: number;
  takeProfit?: number;
  _id?: string;
  timestamp?: string;
  
}
export interface Position {
  positionId: string;
  symbol: string;
  lotSize: number;
  entryTime: string;
  stopLoss: number;
  takeProfit?: number;
  profitLoss: number;
  accountId: string;
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

// ==================== EXISTING FUNCTIONS (UNCHANGED) ====================


export const closePosition = async (
  symbol: string,
  type: 'BUY' | 'SELL',
  positionSide: string,
  volume: number
) => {
  const socket = getSocket();
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }

  return new Promise((resolve, reject) => {
    socket.emit('close-position', {
      symbol,
      type,
      positionSide,
      volume,
      timestamp: new Date().toISOString()
    });

    socket.once('close-position-response', (response: { success: boolean; message?: string; error?: string }) => {
      console.log(`[${new Date().toISOString()}] Received close position response:`, response);
      if (response.error) {
        console.error(`[${new Date().toISOString()}] Close position failed: ${response.error}`);
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
};


export const cancelOrder = async (clientOrderId: string) => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }
  return new Promise((resolve, reject) => {
    socket.emit('cancel-order', { clientOrderId, timestamp: new Date().toISOString() });
    socket.once('cancel-order-response', (response: { success: boolean; message?: string; error?: string }) => {
      console.log(`[${new Date().toISOString()}] Received cancel order response:`, response);
      if (response.error) {
        console.error(`[${new Date().toISOString()}] Cancel order failed: ${response.error}`);
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
};

export const setBlockStatus = async (duration: number) => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }
  return new Promise((resolve, reject) => {
    socket.emit('set-block-status', { duration, timestamp: new Date().toISOString() });
    socket.once('block-status-response', (response: { success: boolean; message?: string; error?: string }) => {
      console.log(`[${new Date().toISOString()}] Received block status response:`, response);
      if (response.error) {
        console.error(`[${new Date().toISOString()}] Block status update failed: ${response.error}`);
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
};

export const activateBurstMode = async () => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }
  return new Promise((resolve, reject) => {
    socket.emit('activate-burst', { timestamp: new Date().toISOString() });
    socket.once('burst-response', (response: { success: boolean; reason?: string }) => {
      console.log(`[${new Date().toISOString()}] Received activate burst response:`, response);
      if (response.reason) {
        console.error(`[${new Date().toISOString()}] Activate burst failed: ${response.reason}`);
        reject(new Error(response.reason));
      } else {
        resolve(response);
      }
    });
  });
};

export const deactivateBurstMode = async () => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }
  return new Promise((resolve, reject) => {
    socket.emit('deactivate-burst', { timestamp: new Date().toISOString() });
    socket.once('burst-response', (response: { success: boolean; message?: string }) => {
      console.log(`[${new Date().toISOString()}] Received deactivate burst response:`, response);
      if (response.message && !response.success) {
        console.error(`[${new Date().toISOString()}] Deactivate burst failed: ${response.message}`);
        reject(new Error(response.message));
      } else {
        resolve(response);
      }
    });
  });
};

export const getsymbolsMode = async () => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }
  return new Promise((resolve, reject) => {
    socket.emit('get-symbols', { timestamp: new Date().toISOString() });
    socket.once('symbols-response', (response: { success: boolean; message?: string }) => {
      console.log(`[${new Date().toISOString()}] Received symbols list response:`, response);
      if (response.message && !response.success) {
        console.error(`[${new Date().toISOString()}] Get symbols failed: ${response.message}`);
        reject(new Error(response.message));
      } else {
        resolve(response);
      }
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
  if (!socket) throw new Error('Socket not connected');
  return new Promise((resolve, reject) => {
    socket.emit('modify-order', {
      ...payload,
      timestamp: new Date().toISOString()
    });
    socket.once('modify-order-response', (resp: { success: boolean; message?: string; error?: string }) => {
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
};

export const addMargin = async (symbol: string, side: 'BUY' | 'SELL', amount: number) => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }
  return new Promise((resolve, reject) => {
    socket.emit('add-margin', { symbol, side, amount, timestamp: new Date().toISOString() });
    socket.once('add-margin-response', (response: { success: boolean; message?: string; error?: string }) => {
      console.log(`[${new Date().toISOString()}] Received add margin response:`, response);
      if (response.error) {
        console.error(`[${new Date().toISOString()}] Add margin failed: ${response.error}`);
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
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

// ==================== NEW: ORDER PREFLIGHT & CONFIRM ====================

export interface OrderPreflightData {
  symbol: string;
  side: 'BUY' | 'SELL';
  stopLoss: number;
  takeProfit: number;
  riskPercent?: number;
}

export interface OrderPreflightResponse {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  markPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskPercent: number;
  maxLossUSDT: number;
  maxProfitUSDT: number;
  riskRewardRatio: string;
}

/**
 * Sends order preflight to backend → returns quantity, max loss/profit, R:R
 */
export const orderPreflight = async (data: OrderPreflightData): Promise<OrderPreflightResponse> => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }

  const payload = { ...data, timestamp: new Date().toISOString() };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Preflight timeout'));
    }, 8000);

    socket.emit('order-preflight', payload);
    socket.once('order-preflight-response', (resp: { error?: string; data?: OrderPreflightResponse }) => {
      clearTimeout(timeout);
      if (resp.error) {
        console.error(`[${new Date().toISOString()}] Preflight failed: ${resp.error}`);
        reject(new Error(resp.error));
      } else if (resp.data) {
        resolve(resp.data);
      } else {
        reject(new Error('Invalid preflight response'));
      }
    });
  });
};

/**
 * Final order placement after user confirms
 */
export const confirmOrder =async (data: OrderPreflightResponse & { isScalping?: boolean }) => {
  if (!socket) {
    const error = 'Socket.IO not connected';
    console.error(`[${new Date().toISOString()}] ${error}`);
    throw new Error(error);
  }

  const payload = {
    symbol: data.symbol,
    side: data.side,
    stopLoss: data.stopLoss,
    takeProfit: data.takeProfit,
    riskPercent: data.riskPercent,
    timestamp: new Date().toISOString(),
    isScalping: data.isScalping || false,

  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Order placement timeout'));
    }, 15000);
    socket.emit('place-full-order', payload);

    socket.once('place-full-order-response', (resp: { success: boolean; data?: any; error?: string }) => {
      clearTimeout(timeout);
      if (resp.error || !resp.success) {
        const msg = resp.error || 'Order failed';
        console.error(`[${new Date().toISOString()}] ${msg}`);
        reject(new Error(msg));
      } else {
        resolve(resp.data);
      }
    });
  });
};


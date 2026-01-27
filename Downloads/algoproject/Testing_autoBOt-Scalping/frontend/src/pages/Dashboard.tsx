
import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
  Chip,
  LinearProgress,
  Divider,
  Stack,
} from '@mui/material';
import { Refresh, TrendingUp, TrendingDown } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: string;
  historyCheckCandles?: number;
  volumeTimeframe?: string; // NEW
  currentPrice?: number;
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: string;
  historyCheckCandles?: number;
  volumeTimeframe?: string; // NEW
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];
          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.currentPrice || p.entryPrice;
          });

          const groups: Record<string, PositionGroup> = {};
          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
    getSocket()?.emit('get-bot-status');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004;
    return unrealized - commission;
  };

  const getPnLColor = (pnl: number) => (pnl > 0 ? '#00ff9d' : '#ff3860');

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#0f172a' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#60a5fa' }} />
        <Typography sx={{ mt: 3, color: '#e2e8f0', fontSize: '1.2rem' }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} variant="outlined" sx={{ mt: 3, color: '#60a5fa', borderColor: '#60a5fa' }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Exo+2:wght@400;600&display=swap" rel="stylesheet" />
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error" variant="filled">{error}</Alert>
      </Snackbar>
      <Box sx={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', py: 4, fontFamily: '"Exo 2", sans-serif' }}>
        <Box sx={{ maxWidth: '1600px', mx: 'auto', px: 3 }}>
          <Card sx={{ mb: 5, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', border: '1px solid #334155' }}>
            <CardContent sx={{ py: 3 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h4" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                    Balance: {balance !== undefined ? `$${balance.toFixed(2)}` : '-'}
                  </Typography>
                  <Typography variant="h6" sx={{ color: '#94a3b8', mt: 1 }}>
                    Today Entries: <span style={{ color: '#60a5fa', fontWeight: 600 }}>{todayEntries}</span> / 90
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={(todayEntries / 30) * 100} sx={{ width: 300, height: 10, borderRadius: 5, backgroundColor: '#334155', '& .MuiLinearProgress-bar': { backgroundColor: '#60a5fa' } }} />
              </Stack>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card sx={{ background: 'rgba(15,23,42,0.6)', borderRadius: 4, py: 8 }}>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h5" color="#64748b">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => {
              const pnl = group.position && group.currentPrice ? calculateUnrealizedPnL(group.position, group.currentPrice) : 0;
              const pnlPercent = group.position ? ((group.currentPrice! - group.position.entryPrice) / group.position.entryPrice) * 100 * (group.position.side === 'BUY' ? 1 : -1) : 0;

              return (
                <Card key={group.key} sx={{ mb: 3, background: 'linear-gradient(145deg, rgba(15,23,42,0.95), rgba(30,41,59,0.8))', borderRadius: 4, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', border: '1px solid #475569', overflow: 'hidden' }}>
                  <CardContent sx={{ p: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Stack direction="row" spacing={2} alignItems="center">
                        <Typography variant="h5" sx={{ color: '#60a5fa', fontWeight: 700, fontFamily: 'Orbitron' }}>
                          {group.symbol}
                        </Typography>
                        <Chip label={group.positionSide} color={group.positionSide === 'LONG' ? 'success' : 'error'} size="small" />
                        <Chip label={group.position?.side || 'Pending'} variant="outlined" sx={{ borderColor: '#60a5fa', color: '#60a5fa' }} size="small" />
                        <Chip label={group.position?.patternType || 'N/A'} sx={{ backgroundColor: '#334155', color: '#e2e8f0' }} size="small" />
                        <Chip label={group.position?.volumeTimeframe || 'N/A'} sx={{ backgroundColor: '#1e40af', color: '#93c5fd' }} size="small" />
                      </Stack>
                      {group.position && group.currentPrice && (
                        <Box textAlign="right">
                          <Typography variant="h4" sx={{ color: getPnLColor(pnl), fontWeight: 800, fontFamily: 'Orbitron' }}>
                            {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} USDT
                          </Typography>
                          <Typography variant="body1" sx={{ color: getPnLColor(pnl) }}>
                            {pnlPercent > 0 ? <TrendingUp fontSize="small" /> : <TrendingDown fontSize="small" />} {pnlPercent.toFixed(2)}%
                          </Typography>
                        </Box>
                      )}
                    </Stack>
                    <Divider sx={{ my: 1.5, backgroundColor: '#334155' }} />
                    {group.position && group.currentPrice ? (
                    <Stack spacing={1.5}>
  <Typography color="#c2f606ff" variant="caption" sx={{ letterSpacing: '0.1em', fontFamily: 'Exo 2', textTransform: 'uppercase', fontSize: '1.1rem' }}>
    QUANTITY ENTRY PRICE CURRENT PRICE LEVERAGE USED MARGIN RISK AMOUNT VOLUME TF HISTORY TF ENTRY TIME
  </Typography>
  <Typography variant="body1" fontWeight="600" sx={{ color: '#905bebff', letterSpacing: '0.2em', fontFamily: 'Exo 2', fontSize: '1.1rem' }}>
    {group.position.qty.toLocaleString()}  {group.position.entryPrice.toFixed(6)}  {group.currentPrice.toFixed(6)}  {group.position.leverage}x  ${group.position.allocatedMargin.toFixed(2)}  ${group.position.riskAmount.toFixed(2)} ----- 
    {group.position.volumeTimeframe || 'N/A'} ---- 
    {group.position.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'} ------- 
    {new Date(group.position.entryTime).toLocaleString(undefined, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: true
    }).replace(',', '')}
  </Typography>
</Stack>
                    ) : (
                      <Typography color="#94a3b8" sx={{ py: 1, textAlign: 'center' }}>Position pending entry</Typography>
                    )}
                    {group.pendingOrders.length > 0 && (
                      <>
                        <Divider sx={{ my: 1.5, backgroundColor: '#334155' }} />
                        <Typography variant="subtitle1" color="#60a5fa" mb={0.5} sx={{ fontFamily: 'Orbitron', letterSpacing: '0.1em' }}>
                          PENDING ORDERS
                        </Typography>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ color: '#60a5fa', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>TYPE</TableCell>
                              <TableCell sx={{ color: '#60a5fa', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>TRIGGER PRICE</TableCell>
                              <TableCell sx={{ color: '#60a5fa', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>QUANTITY</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {group.pendingOrders.map((o) => (
                              <TableRow key={o.ClientId}>
                                <TableCell sx={{ py: 0.5 }}>
                                  <Chip
                                    label={o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                                    color={o.type === 'STOP_MARKET' ? 'error' : 'success'}
                                    size="small"
                                    sx={{ fontFamily: 'Exo 2' }}
                                  />
                                </TableCell>
                                <TableCell sx={{ color: '#00ff9d', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>
                                  {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                                </TableCell>
                                <TableCell sx={{ color: '#00ff9d', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>
                                  {o.Qty.toLocaleString()}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}

          <Card sx={{ mt: 6, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
            <CardContent sx={{ p: 4 }}>
              <Typography variant="h5" color="#60a5fa" mb={3} fontWeight={700} sx={{ fontFamily: 'Orbitron' }}>
                Trade History
              </Typography>
              {history.length === 0 ? (
                <Typography color="#64748b" sx={{ py: 6, textAlign: 'center' }}>No trades yet</Typography>
              ) : (
                <>
                  <TableContainer component={Paper} sx={{ background: 'transparent', boxShadow: 'none' }}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Time</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Symbol</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Side</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Pattern</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Volume TF</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Qty</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Entry</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>PnL</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit Type</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.map((t, i) => (
                          <TableRow key={i} hover sx={{ '&:hover': { backgroundColor: 'rgba(96,165,250,0.05)' } }}>
                            <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#60a5fa', fontWeight: 600 }}>{t.symbol}</TableCell>
                            <TableCell>
                              <Chip
                                label={`${t.side} ${t.positionSide}`}
                                color={t.side === 'BUY' ? 'success' : 'error'}
                                size="small"
                              />
                            </TableCell>
                            <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                            <TableCell sx={{ color: '#60a5fa' }}>{t.volumeTimeframe || '-'}</TableCell>
                            <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: t.isWin ? '#00ff9d' : '#ff3860', fontWeight: 'bold' }}>
                              {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Chip label={t.exitType} color={t.exitType === 'TP' ? 'success' : 'error'} size="small" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Pagination
                    count={historyTotalPages}
                    page={historyPage}
                    onChange={(_, p) => loadHistory(p)}
                    color="primary"
                    sx={{ mt: 4, display: 'flex', justifyContent: 'center' }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;



/*
import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
  Chip,
  LinearProgress,
  Divider,
  Stack,
} from '@mui/material';
import { Refresh, TrendingUp, TrendingDown } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: string;
  historyCheckCandles?: number;
  currentPrice?: number;
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: string;
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          console.log('Received live-data:', data);
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];

          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.currentPrice || p.entryPrice;
          });

          const groups: Record<string, PositionGroup> = {};
          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
    getSocket()?.emit('get-bot-status');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004;
    return unrealized - commission;
  };

  const getPnLColor = (pnl: number) => (pnl > 0 ? '#00ff9d' : '#ff3860');

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#0f172a' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#60a5fa' }} />
        <Typography sx={{ mt: 3, color: '#e2e8f0', fontSize: '1.2rem' }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} variant="outlined" sx={{ mt: 3, color: '#60a5fa', borderColor: '#60a5fa' }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Exo+2:wght@400;600&display=swap" rel="stylesheet" />
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error" variant="filled">{error}</Alert>
      </Snackbar>
      <Box sx={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', py: 4, fontFamily: '"Exo 2", sans-serif' }}>
        <Box sx={{ maxWidth: '1600px', mx: 'auto', px: 3 }}>
          <Card sx={{ mb: 5, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', border: '1px solid #334155' }}>
            <CardContent sx={{ py: 3 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h4" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                    Balance: {balance !== undefined ? `$${balance.toFixed(2)}` : '-'}
                  </Typography>
                  <Typography variant="h6" sx={{ color: '#94a3b8', mt: 1 }}>
                    Today Entries: <span style={{ color: '#60a5fa', fontWeight: 600 }}>{todayEntries}</span> / 30000
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={(todayEntries / 30000) * 100} sx={{ width: 300, height: 10, borderRadius: 5, backgroundColor: '#334155', '& .MuiLinearProgress-bar': { backgroundColor: '#60a5fa' } }} />
              </Stack>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card sx={{ background: 'rgba(15,23,42,0.6)', borderRadius: 4, py: 8 }}>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h5" color="#64748b">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => {
              const pnl = group.position && group.currentPrice ? calculateUnrealizedPnL(group.position, group.currentPrice) : 0;
              const pnlPercent = group.position ? ((group.currentPrice! - group.position.entryPrice) / group.position.entryPrice) * 100 * (group.position.side === 'BUY' ? 1 : -1) : 0;

              return (
                <Card key={group.key} sx={{ mb: 3, background: 'linear-gradient(145deg, rgba(15,23,42,0.95), rgba(30,41,59,0.8))', borderRadius: 4, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', border: '1px solid #475569', overflow: 'hidden' }}>
                  <CardContent sx={{ p: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Stack direction="row" spacing={2} alignItems="center">
                        <Typography variant="h5" sx={{ color: '#60a5fa', fontWeight: 700, fontFamily: 'Orbitron' }}>
                          {group.symbol}
                        </Typography>
                        <Chip label={group.positionSide} color={group.positionSide === 'LONG' ? 'success' : 'error'} size="small" />
                        <Chip label={group.position?.side || 'Pending'} variant="outlined" sx={{ borderColor: '#60a5fa', color: '#60a5fa' }} size="small" />
                        <Chip label={group.position?.patternType || 'N/A'} sx={{ backgroundColor: '#334155', color: '#e2e8f0' }} size="small" />
                      </Stack>
                      {group.position && group.currentPrice && (
                        <Box textAlign="right">
                          <Typography variant="h4" sx={{ color: getPnLColor(pnl), fontWeight: 800, fontFamily: 'Orbitron' }}>
                            {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} USDT
                          </Typography>
                          <Typography variant="body1" sx={{ color: getPnLColor(pnl) }}>
                            {pnlPercent > 0 ? <TrendingUp fontSize="small" /> : <TrendingDown fontSize="small" />} {pnlPercent.toFixed(2)}%
                          </Typography>
                        </Box>
                      )}
                    </Stack>

                    <Divider sx={{ my: 1.5, backgroundColor: '#334155' }} />

                    {group.position && group.currentPrice ? (
                      <Stack spacing={1.5}>
                        <Typography color="#c2f606ff" variant="caption" sx={{ letterSpacing: '0.1.9em', fontFamily: 'Exo 2', textTransform: 'uppercase', fontSize: '1.1rem' }}>
                          QUANTITY ENTRY PRICE   CURRENT PRICE LEVERAGE USED MARGIN RISK AMOUNT TIMEFRAME ENTRY TIME
                        </Typography>
                        <Typography variant="body1" fontWeight="600" sx={{ color: '#905bebff', letterSpacing: '0.2em', fontFamily: 'Exo 2', fontSize: '1.1rem' }}>
                          {group.position.qty.toLocaleString()}   {group.position.entryPrice.toFixed(6)}   {group.currentPrice.toFixed(6)}   {group.position.leverage}x   ${group.position.allocatedMargin.toFixed(2)}   ${group.position.riskAmount.toFixed(2)}   {group.position.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'}   {new Date(group.position.entryTime).toLocaleString()}
                        </Typography>
                      </Stack>
                    ) : (
                      <Typography color="#94a3b8" sx={{ py: 1, textAlign: 'center' }}>Position pending entry</Typography>
                    )}

                                      {group.pendingOrders.length > 0 && (
                      <>
                        <Divider sx={{ my: 1.5, backgroundColor: '#334155' }} />
                        <Typography variant="subtitle1" color="#60a5fa" mb={0.5} sx={{ fontFamily: 'Orbitron', letterSpacing: '0.1em' }}>
                          PENDING ORDERS
                        </Typography>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ color: '#60a5fa', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>TYPE</TableCell>
                              <TableCell sx={{ color: '#60a5fa', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>TRIGGER PRICE</TableCell>
                              <TableCell sx={{ color: '#60a5fa', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>QUANTITY</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {group.pendingOrders.map((o) => (
                              <TableRow key={o.ClientId}>
                                <TableCell sx={{ py: 0.5 }}>
                                  <Chip
                                    label={o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                                    color={o.type === 'STOP_MARKET' ? 'error' : 'success'}
                                    size="small"
                                    sx={{ fontFamily: 'Exo 2' }}
                                  />
                                </TableCell>
                                <TableCell sx={{ color: '#00ff9d', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>
                                  {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                                </TableCell>
                                <TableCell sx={{ color: '#00ff9d', py: 0.5, fontFamily: 'Exo 2', fontWeight: 600 }}>
                                  {o.Qty.toLocaleString()}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}

          <Card sx={{ mt: 6, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
            <CardContent sx={{ p: 4 }}>
              <Typography variant="h5" color="#60a5fa" mb={3} fontWeight={700} sx={{ fontFamily: 'Orbitron' }}>
                Trade History
              </Typography>
              {history.length === 0 ? (
                <Typography color="#64748b" sx={{ py: 6, textAlign: 'center' }}>No trades yet</Typography>
              ) : (
                <>
                  <TableContainer component={Paper} sx={{ background: 'transparent', boxShadow: 'none' }}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Time</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Symbol</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Side</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Pattern</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Qty</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Entry</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>PnL</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit Type</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.map((t, i) => (
                          <TableRow key={i} hover sx={{ '&:hover': { backgroundColor: 'rgba(96,165,250,0.05)' } }}>
                            <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#60a5fa', fontWeight: 600 }}>{t.symbol}</TableCell>
                            <TableCell>
                              <Chip
                                label={`${t.side} ${t.positionSide}`}
                                color={t.side === 'BUY' ? 'success' : 'error'}
                                size="small"
                              />
                            </TableCell>
                            <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                            <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: t.isWin ? '#00ff9d' : '#ff3860', fontWeight: 'bold' }}>
                              {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Chip label={t.exitType} color={t.exitType === 'TP' ? 'success' : 'error'} size="small" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Pagination
                    count={historyTotalPages}
                    page={historyPage}
                    onChange={(_, p) => loadHistory(p)}
                    color="primary"
                    sx={{ mt: 4, display: 'flex', justifyContent: 'center' }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;

/*
import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
  Chip,
  LinearProgress,
  Divider,
  Stack,
} from '@mui/material';
import { Refresh, TrendingUp, TrendingDown } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: string;
  historyCheckCandles?: number;
  currentPrice?: number;
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: string;
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          console.log('Received live-data:', data);
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];

          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.currentPrice || p.entryPrice;
          });

          const groups: Record<string, PositionGroup> = {};
          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
    getSocket()?.emit('get-bot-status');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004;
    return unrealized - commission;
  };

  const getPnLColor = (pnl: number) => (pnl > 0 ? '#00ff9d' : '#ff3860');

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#0f172a' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#60a5fa' }} />
        <Typography sx={{ mt: 3, color: '#e2e8f0', fontSize: '1.2rem' }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} variant="outlined" sx={{ mt: 3, color: '#60a5fa', borderColor: '#60a5fa' }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error" variant="filled">{error}</Alert>
      </Snackbar>
      <Box sx={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', py: 4 }}>
        <Box sx={{ maxWidth: '1600px', mx: 'auto', px: 3 }}>
          <Card sx={{ mb: 5, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', border: '1px solid #334155' }}>
            <CardContent sx={{ py: 3 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h4" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                    Balance: {balance !== undefined ? `$${balance.toFixed(2)}` : '-'}
                  </Typography>
                  <Typography variant="h6" sx={{ color: '#94a3b8', mt: 1 }}>
                    Today Entries: <span style={{ color: '#60a5fa', fontWeight: 600 }}>{todayEntries}</span> / 30000
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={(todayEntries / 30000) * 100} sx={{ width: 300, height: 10, borderRadius: 5, backgroundColor: '#334155', '& .MuiLinearProgress-bar': { backgroundColor: '#60a5fa' } }} />
              </Stack>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card sx={{ background: 'rgba(15,23,42,0.6)', borderRadius: 4, py: 8 }}>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h5" color="#64748b">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => {
              const pnl = group.position && group.currentPrice ? calculateUnrealizedPnL(group.position, group.currentPrice) : 0;
              const pnlPercent = group.position ? ((group.currentPrice! - group.position.entryPrice) / group.position.entryPrice) * 100 * (group.position.side === 'BUY' ? 1 : -1) : 0;

              return (
                <Card key={group.key} sx={{ mb: 3, background: 'linear-gradient(145deg, rgba(15,23,42,0.95), rgba(30,41,59,0.8))', borderRadius: 4, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', border: '1px solid #475569', overflow: 'hidden' }}>
                  <CardContent sx={{ p: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Stack direction="row" spacing={2} alignItems="center">
                        <Typography variant="h5" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                          {group.symbol}
                        </Typography>
                        <Chip label={group.positionSide} color={group.positionSide === 'LONG' ? 'success' : 'error'} size="small" />
                        <Chip label={group.position?.side || 'Pending'} variant="outlined" sx={{ borderColor: '#60a5fa', color: '#60a5fa' }} size="small" />
                        <Chip label={group.position?.patternType || 'N/A'} sx={{ backgroundColor: '#334155', color: '#e2e8f0' }} size="small" />
                      </Stack>
                      {group.position && group.currentPrice && (
                        <Box textAlign="right">
                          <Typography variant="h4" sx={{ color: getPnLColor(pnl), fontWeight: 800 }}>
                            {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} USDT
                          </Typography>
                          <Typography variant="body1" sx={{ color: getPnLColor(pnl) }}>
                            {pnlPercent > 0 ? <TrendingUp fontSize="small" /> : <TrendingDown fontSize="small" />} {pnlPercent.toFixed(2)}%
                          </Typography>
                        </Box>
                      )}
                    </Stack>

                    <Divider sx={{ my: 1, backgroundColor: '#334155' }} />

                    {group.position && group.currentPrice ? (
                      <Stack spacing={0.8}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Quantity</Typography>
                          <Typography color="#00ff9d" variant="body1" fontWeight="600">{group.position.qty.toLocaleString()}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Entry Price</Typography>
                          <Typography color="#00ccff" variant="body1" fontWeight="600">{group.position.entryPrice.toFixed(6)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Current Price</Typography>
                          <Typography color="#ff00ff" variant="body1" fontWeight="600">{group.currentPrice.toFixed(6)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Leverage</Typography>
                          <Typography color="#00ff9d" variant="body1" fontWeight="600">{group.position.leverage}x</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Used Margin</Typography>
                          <Typography color="#ff00ff" variant="body1" fontWeight="600">${group.position.allocatedMargin.toFixed(2)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Risk Amount</Typography>
                          <Typography color="#ff3860" variant="body1" fontWeight="600">${group.position.riskAmount.toFixed(2)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Timeframe</Typography>
                          <Typography color="#00ff9d" variant="body1" fontWeight="600">
                            {group.position.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'}
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Entry Time</Typography>
                          <Typography color="#a0a0a0" variant="body1" fontWeight="600">{new Date(group.position.entryTime).toLocaleString()}</Typography>
                        </Box>
                      </Stack>
                    ) : (
                      <Typography color="#94a3b8" sx={{ py: 1, textAlign: 'center' }}>Position pending entry</Typography>
                    )}

                    {group.pendingOrders.length > 0 && (
                      <>
                        <Divider sx={{ my: 1.5, backgroundColor: '#334155' }} />
                        <Typography variant="subtitle1" color="#60a5fa" mb={0.5}>Pending Orders</Typography>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Type</TableCell>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Trigger Price</TableCell>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Quantity</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {group.pendingOrders.map((o) => (
                              <TableRow key={o.ClientId}>
                                <TableCell sx={{ py: 0.5 }}>
                                  <Chip
                                    label={o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                                    color={o.type === 'STOP_MARKET' ? 'error' : 'success'}
                                    size="small"
                                  />
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0', py: 0.5 }}>
                                  {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0', py: 0.5 }}>{o.Qty.toLocaleString()}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}

          <Card sx={{ mt: 6, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
            <CardContent sx={{ p: 4 }}>
              <Typography variant="h5" color="#60a5fa" mb={3} fontWeight={700}>
                Trade History
              </Typography>
              {history.length === 0 ? (
                <Typography color="#64748b" sx={{ py: 6, textAlign: 'center' }}>No trades yet</Typography>
              ) : (
                <>
                  <TableContainer component={Paper} sx={{ background: 'transparent', boxShadow: 'none' }}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Time</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Symbol</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Side</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Pattern</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Qty</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Entry</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>PnL</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit Type</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.map((t, i) => (
                          <TableRow key={i} hover sx={{ '&:hover': { backgroundColor: 'rgba(96,165,250,0.05)' } }}>
                            <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#60a5fa', fontWeight: 600 }}>{t.symbol}</TableCell>
                            <TableCell>
                              <Chip
                                label={`${t.side} ${t.positionSide}`}
                                color={t.side === 'BUY' ? 'success' : 'error'}
                                size="small"
                              />
                            </TableCell>
                            <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                            <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: t.isWin ? '#00ff9d' : '#ff3860', fontWeight: 'bold' }}>
                              {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Chip label={t.exitType} color={t.exitType === 'TP' ? 'success' : 'error'} size="small" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Pagination
                    count={historyTotalPages}
                    page={historyPage}
                    onChange={(_, p) => loadHistory(p)}
                    color="primary"
                    sx={{ mt: 4, display: 'flex', justifyContent: 'center' }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;


/*

import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
  Chip,
  LinearProgress,
  Divider,
  Stack,
} from '@mui/material';
import { Refresh, TrendingUp, TrendingDown } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: string;
  historyCheckCandles?: number;
  currentPrice?: number;
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: string;
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          console.log('Received live-data:', data);
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];

          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.currentPrice || p.entryPrice;
          });

          const groups: Record<string, PositionGroup> = {};
          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
    getSocket()?.emit('get-bot-status');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004;
    return unrealized - commission;
  };

  const getPnLColor = (pnl: number) => (pnl > 0 ? '#00ff9d' : '#ff3860');

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#0f172a' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#60a5fa' }} />
        <Typography sx={{ mt: 3, color: '#e2e8f0', fontSize: '1.2rem' }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} variant="outlined" sx={{ mt: 3, color: '#60a5fa', borderColor: '#60a5fa' }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error" variant="filled">{error}</Alert>
      </Snackbar>
      <Box sx={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', py: 4 }}>
        <Box sx={{ maxWidth: '1600px', mx: 'auto', px: 3 }}>
          <Card sx={{ mb: 5, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', border: '1px solid #334155' }}>
            <CardContent sx={{ py: 3 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h4" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                    Balance: {balance !== undefined ? `$${balance.toFixed(2)}` : '-'}
                  </Typography>
                  <Typography variant="h6" sx={{ color: '#94a3b8', mt: 1 }}>
                    Today Entries: <span style={{ color: '#60a5fa', fontWeight: 600 }}>{todayEntries}</span> / 30000
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={(todayEntries / 30000) * 100} sx={{ width: 300, height: 10, borderRadius: 5, backgroundColor: '#334155', '& .MuiLinearProgress-bar': { backgroundColor: '#60a5fa' } }} />
              </Stack>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card sx={{ background: 'rgba(15,23,42,0.6)', borderRadius: 4, py: 8 }}>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h5" color="#64748b">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => {
              const pnl = group.position && group.currentPrice ? calculateUnrealizedPnL(group.position, group.currentPrice) : 0;
              const pnlPercent = group.position ? ((group.currentPrice! - group.position.entryPrice) / group.position.entryPrice) * 100 * (group.position.side === 'BUY' ? 1 : -1) : 0;

              return (
                <Card key={group.key} sx={{ mb: 3, background: 'linear-gradient(145deg, rgba(15,23,42,0.95), rgba(30,41,59,0.8))', borderRadius: 4, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', border: '1px solid #475569', overflow: 'hidden' }}>
                  <CardContent sx={{ p: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Box>
                        <Typography variant="h5" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                          {group.symbol}
                        </Typography>
                        <Stack direction="row" spacing={1} mt={0.5}>
                          <Chip label={group.positionSide} color={group.positionSide === 'LONG' ? 'success' : 'error'} size="small" />
                          <Chip label={group.position?.side || 'Pending'} variant="outlined" sx={{ borderColor: '#60a5fa', color: '#60a5fa' }} size="small" />
                          <Chip label={group.position?.patternType || 'N/A'} sx={{ backgroundColor: '#334155', color: '#e2e8f0' }} size="small" />
                        </Stack>
                      </Box>
                      {group.position && group.currentPrice && (
                        <Box textAlign="right">
                          <Typography variant="h4" sx={{ color: getPnLColor(pnl), fontWeight: 800 }}>
                            {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} USDT
                          </Typography>
                          <Typography variant="body1" sx={{ color: getPnLColor(pnl) }}>
                            {pnlPercent > 0 ? <TrendingUp fontSize="small" /> : <TrendingDown fontSize="small" />} {pnlPercent.toFixed(2)}%
                          </Typography>
                        </Box>
                      )}
                    </Stack>

                    <Divider sx={{ my: 1, backgroundColor: '#334155' }} />

                    {group.position && group.currentPrice ? (
                      <Stack spacing={0.8}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Quantity</Typography>
                          <Typography color="#00ff9d" variant="body1" fontWeight="600">{group.position.qty.toLocaleString()}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Entry Price</Typography>
                          <Typography color="#00ccff" variant="body1" fontWeight="600">{group.position.entryPrice.toFixed(6)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Current Price</Typography>
                          <Typography color="#ff00ff" variant="body1" fontWeight="600">{group.currentPrice.toFixed(6)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Leverage</Typography>
                          <Typography color="#00ff9d" variant="body1" fontWeight="600">{group.position.leverage}x</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Used Margin</Typography>
                          <Typography color="#ff00ff" variant="body1" fontWeight="600">${group.position.allocatedMargin.toFixed(2)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Risk Amount</Typography>
                          <Typography color="#ff3860" variant="body1" fontWeight="600">${group.position.riskAmount.toFixed(2)}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Timeframe</Typography>
                          <Typography color="#00ff9d" variant="body1" fontWeight="600">
                            {group.position.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'}
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography color="#94a3b8" variant="body2">Entry Time</Typography>
                          <Typography color="#a0a0a0" variant="body1" fontWeight="600">{new Date(group.position.entryTime).toLocaleString()}</Typography>
                        </Box>
                      </Stack>
                    ) : (
                      <Typography color="#94a3b8" sx={{ py: 1, textAlign: 'center' }}>Position pending entry</Typography>
                    )}

                    {group.pendingOrders.length > 0 && (
                      <>
                        <Divider sx={{ my: 1.5, backgroundColor: '#334155' }} />
                        <Typography variant="subtitle1" color="#60a5fa" mb={0.5}>Pending Orders</Typography>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Type</TableCell>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Trigger Price</TableCell>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Quantity</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {group.pendingOrders.map((o) => (
                              <TableRow key={o.ClientId}>
                                <TableCell sx={{ py: 0.5 }}>
                                  <Chip
                                    label={o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                                    color={o.type === 'STOP_MARKET' ? 'error' : 'success'}
                                    size="small"
                                  />
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0', py: 0.5 }}>
                                  {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0', py: 0.5 }}>{o.Qty.toLocaleString()}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}

          <Card sx={{ mt: 6, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
            <CardContent sx={{ p: 4 }}>
              <Typography variant="h5" color="#60a5fa" mb={3} fontWeight={700}>
                Trade History
              </Typography>
              {history.length === 0 ? (
                <Typography color="#64748b" sx={{ py: 6, textAlign: 'center' }}>No trades yet</Typography>
              ) : (
                <>
                  <TableContainer component={Paper} sx={{ background: 'transparent', boxShadow: 'none' }}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Time</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Symbol</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Side</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Pattern</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Qty</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Entry</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>PnL</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit Type</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.map((t, i) => (
                          <TableRow key={i} hover sx={{ '&:hover': { backgroundColor: 'rgba(96,165,250,0.05)' } }}>
                            <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#60a5fa', fontWeight: 600 }}>{t.symbol}</TableCell>
                            <TableCell>
                              <Chip
                                label={`${t.side} ${t.positionSide}`}
                                color={t.side === 'BUY' ? 'success' : 'error'}
                                size="small"
                              />
                            </TableCell>
                            <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                            <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: t.isWin ? '#00ff9d' : '#ff3860', fontWeight: 'bold' }}>
                              {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Chip label={t.exitType} color={t.exitType === 'TP' ? 'success' : 'error'} size="small" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Pagination
                    count={historyTotalPages}
                    page={historyPage}
                    onChange={(_, p) => loadHistory(p)}
                    color="primary"
                    sx={{ mt: 4, display: 'flex', justifyContent: 'center' }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;


/*

import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
  Chip,
  LinearProgress,
  Divider,
  Stack,
} from '@mui/material';
import { Refresh, TrendingUp, TrendingDown } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: string;
  historyCheckCandles?: number;
  currentPrice?: number;
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: string;
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          console.log('Received live-data:', data);
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];

          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.currentPrice || p.entryPrice;
          });

          const groups: Record<string, PositionGroup> = {};
          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
    getSocket()?.emit('get-bot-status');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004;
    return unrealized - commission;
  };

  const getPnLColor = (pnl: number) => (pnl > 0 ? '#00ff9d' : '#ff3860');

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#0f172a' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#60a5fa' }} />
        <Typography sx={{ mt: 3, color: '#e2e8f0', fontSize: '1.2rem' }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} variant="outlined" sx={{ mt: 3, color: '#60a5fa', borderColor: '#60a5fa' }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error" variant="filled">{error}</Alert>
      </Snackbar>
      <Box sx={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', py: 4 }}>
        <Box sx={{ maxWidth: '1600px', mx: 'auto', px: 3 }}>
          <Card sx={{ mb: 5, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', border: '1px solid #334155' }}>
            <CardContent sx={{ py: 3 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h4" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                    Balance: {balance !== undefined ? `$${balance.toFixed(2)}` : '-'}
                  </Typography>
                  <Typography variant="h6" sx={{ color: '#94a3b8', mt: 1 }}>
                    Today Entries: <span style={{ color: '#60a5fa', fontWeight: 600 }}>{todayEntries}</span> / 30000
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={(todayEntries / 30000) * 100} sx={{ width: 300, height: 10, borderRadius: 5, backgroundColor: '#334155', '& .MuiLinearProgress-bar': { backgroundColor: '#60a5fa' } }} />
              </Stack>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card sx={{ background: 'rgba(15,23,42,0.6)', borderRadius: 4, py: 8 }}>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h5" color="#64748b">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => {
              const pnl = group.position && group.currentPrice ? calculateUnrealizedPnL(group.position, group.currentPrice) : 0;
              const pnlPercent = group.position ? ((group.currentPrice! - group.position.entryPrice) / group.position.entryPrice) * 100 * (group.position.side === 'BUY' ? 1 : -1) : 0;

              return (
                <Card key={group.key} sx={{ mb: 3, background: 'linear-gradient(145deg, rgba(15,23,42,0.95), rgba(30,41,59,0.8))', borderRadius: 4, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', border: '1px solid #475569', overflow: 'hidden' }}>
                  <CardContent sx={{ p: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Box>
                        <Typography variant="h5" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                          {group.symbol}
                        </Typography>
                        <Stack direction="row" spacing={1} mt={0.5}>
                          <Chip label={group.positionSide} color={group.positionSide === 'LONG' ? 'success' : 'error'} size="small" />
                          <Chip label={group.position?.side || 'Pending'} variant="outlined" sx={{ borderColor: '#60a5fa', color: '#60a5fa' }} size="small" />
                          <Chip label={group.position?.patternType || 'N/A'} sx={{ backgroundColor: '#334155', color: '#e2e8f0' }} size="small" />
                        </Stack>
                      </Box>
                      {group.position && group.currentPrice && (
                        <Box textAlign="right">
                          <Typography variant="h4" sx={{ color: getPnLColor(pnl), fontWeight: 800 }}>
                            {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} USDT
                          </Typography>
                          <Typography variant="body1" sx={{ color: getPnLColor(pnl) }}>
                            {pnlPercent > 0 ? <TrendingUp fontSize="small" /> : <TrendingDown fontSize="small" />} {pnlPercent.toFixed(2)}%
                          </Typography>
                        </Box>
                      )}
                    </Stack>

                    <Divider sx={{ my: 1, backgroundColor: '#334155' }} />

                    {group.position && group.currentPrice ? (
                      <Stack spacing={0.5}>
                        <Typography color="#94a3b8" variant="body2"><strong>Quantity:</strong> {group.position.qty.toLocaleString()}</Typography>
                        <Typography color="#94a3b8" variant="body2"><strong>Entry Price:</strong> {group.position.entryPrice.toFixed(6)}</Typography>
                        <Typography color="#94a3b8" variant="body2"><strong>Current Price:</strong> {group.currentPrice.toFixed(6)}</Typography>
                        <Typography color="#94a3b8" variant="body2"><strong>Leverage:</strong> {group.position.leverage}x</Typography>
                        <Typography color="#94a3b8" variant="body2"><strong>Used Margin:</strong> ${group.position.allocatedMargin.toFixed(2)}</Typography>
                        <Typography color="#94a3b8" variant="body2"><strong>Risk Amount:</strong> ${group.position.riskAmount.toFixed(2)}</Typography>
                        <Typography color="#94a3b8" variant="body2"><strong>Timeframe:</strong> {group.position.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'}</Typography>
                        <Typography color="#94a3b8" variant="body2"><strong>Entry Time:</strong> {new Date(group.position.entryTime).toLocaleString()}</Typography>
                      </Stack>
                    ) : (
                      <Typography color="#94a3b8" sx={{ py: 1, textAlign: 'center' }}>Position pending entry</Typography>
                    )}

                    {group.pendingOrders.length > 0 && (
                      <>
                        <Divider sx={{ my: 1.5, backgroundColor: '#334155' }} />
                        <Typography variant="subtitle1" color="#60a5fa" mb={0.5}>Pending Orders</Typography>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Type</TableCell>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Trigger Price</TableCell>
                              <TableCell sx={{ color: '#94a3b8', py: 0.5 }}>Quantity</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {group.pendingOrders.map((o) => (
                              <TableRow key={o.ClientId}>
                                <TableCell sx={{ py: 0.5 }}>
                                  <Chip
                                    label={o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                                    color={o.type === 'STOP_MARKET' ? 'error' : 'success'}
                                    size="small"
                                  />
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0', py: 0.5 }}>
                                  {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0', py: 0.5 }}>{o.Qty.toLocaleString()}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}

          <Card sx={{ mt: 6, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
            <CardContent sx={{ p: 4 }}>
              <Typography variant="h5" color="#60a5fa" mb={3} fontWeight={700}>
                Trade History
              </Typography>
              {history.length === 0 ? (
                <Typography color="#64748b" sx={{ py: 6, textAlign: 'center' }}>No trades yet</Typography>
              ) : (
                <>
                  <TableContainer component={Paper} sx={{ background: 'transparent', boxShadow: 'none' }}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Time</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Symbol</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Side</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Pattern</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Qty</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Entry</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>PnL</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit Type</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.map((t, i) => (
                          <TableRow key={i} hover sx={{ '&:hover': { backgroundColor: 'rgba(96,165,250,0.05)' } }}>
                            <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#60a5fa', fontWeight: 600 }}>{t.symbol}</TableCell>
                            <TableCell>
                              <Chip
                                label={`${t.side} ${t.positionSide}`}
                                color={t.side === 'BUY' ? 'success' : 'error'}
                                size="small"
                              />
                            </TableCell>
                            <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                            <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: t.isWin ? '#00ff9d' : '#ff3860', fontWeight: 'bold' }}>
                              {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Chip label={t.exitType} color={t.exitType === 'TP' ? 'success' : 'error'} size="small" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Pagination
                    count={historyTotalPages}
                    page={historyPage}
                    onChange={(_, p) => loadHistory(p)}
                    color="primary"
                    sx={{ mt: 4, display: 'flex', justifyContent: 'center' }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;


/*

import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
  Chip,
  Avatar,
  LinearProgress,
  Divider,
  Stack,
} from '@mui/material';
import { Refresh, TrendingUp, TrendingDown } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: string;
  historyCheckCandles?: number;
  currentPrice?: number;
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: string;
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          console.log('Received live-data:', data);
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];

          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.currentPrice || p.entryPrice;
          });

          const groups: Record<string, PositionGroup> = {};
          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
    getSocket()?.emit('get-bot-status');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004;
    return unrealized - commission;
  };

  const getPnLColor = (pnl: number) => (pnl > 0 ? '#00ff9d' : '#ff3860');

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#0f172a' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#60a5fa' }} />
        <Typography sx={{ mt: 3, color: '#e2e8f0', fontSize: '1.2rem' }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} variant="outlined" sx={{ mt: 3, color: '#60a5fa', borderColor: '#60a5fa' }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error" variant="filled">{error}</Alert>
      </Snackbar>
      <Box sx={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', py: 4 }}>
        <Box sx={{ maxWidth: '1600px', mx: 'auto', px: 3 }}>
          <Card sx={{ mb: 5, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', border: '1px solid #334155' }}>
            <CardContent sx={{ py: 4 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={4} alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h4" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                    Balance: {balance !== undefined ? `$${balance.toFixed(2)}` : '-'}
                  </Typography>
                  <Typography variant="h6" sx={{ color: '#94a3b8', mt: 1 }}>
                    Today Entries: <span style={{ color: '#60a5fa', fontWeight: 600 }}>{todayEntries}</span> / 30000
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={(todayEntries / 30000) * 100} sx={{ width: 300, height: 10, borderRadius: 5, backgroundColor: '#334155', '& .MuiLinearProgress-bar': { backgroundColor: '#60a5fa' } }} />
              </Stack>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card sx={{ background: 'rgba(15,23,42,0.6)', borderRadius: 4, py: 8 }}>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography variant="h5" color="#64748b">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => {
              const pnl = group.position && group.currentPrice ? calculateUnrealizedPnL(group.position, group.currentPrice) : 0;
              const pnlPercent = group.position ? ((group.currentPrice! - group.position.entryPrice) / group.position.entryPrice) * 100 * (group.position.side === 'BUY' ? 1 : -1) : 0;

              return (
                <Card key={group.key} sx={{ mb: 4, background: 'linear-gradient(145deg, rgba(15,23,42,0.95), rgba(30,41,59,0.8))', borderRadius: 4, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', border: '1px solid #475569', overflow: 'hidden' }}>
                  <CardContent sx={{ p: 4 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={3}>
                      <Box>
                        <Typography variant="h5" sx={{ color: '#60a5fa', fontWeight: 700 }}>
                          {group.symbol}
                        </Typography>
                        <Stack direction="row" spacing={2} mt={1}>
                          <Chip label={group.positionSide} color={group.positionSide === 'LONG' ? 'success' : 'error'} size="small" />
                          <Chip label={group.position?.side || 'Pending'} variant="outlined" sx={{ borderColor: '#60a5fa', color: '#60a5fa' }} size="small" />
                          <Chip label={group.position?.patternType || 'N/A'} sx={{ backgroundColor: '#334155', color: '#e2e8f0' }} size="small" />
                        </Stack>
                      </Box>
                      {group.position && group.currentPrice && (
                        <Box textAlign="right">
                          <Typography variant="h4" sx={{ color: getPnLColor(pnl), fontWeight: 800 }}>
                            {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} USDT
                          </Typography>
                          <Typography variant="body1" sx={{ color: getPnLColor(pnl) }}>
                            {pnlPercent > 0 ? <TrendingUp fontSize="small" /> : <TrendingDown fontSize="small" />} {pnlPercent.toFixed(2)}%
                          </Typography>
                        </Box>
                      )}
                    </Stack>

                    <Divider sx={{ my: 3, backgroundColor: '#334155' }} />

                    {group.position && group.currentPrice ? (
                      <Stack spacing={2}>
                        <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, 1fr)' }} gap={3}>
                          <Box>
                            <Typography color="#94a3b8">Quantity</Typography>
                            <Typography variant="h6" color="#e2e8f0">{group.position.qty.toLocaleString()}</Typography>
                          </Box>
                          <Box>
                            <Typography color="#94a3b8">Entry Price</Typography>
                            <Typography variant="h6" color="#3b82f6">{group.position.entryPrice.toFixed(6)}</Typography>
                          </Box>
                          <Box>
                            <Typography color="#94a3b8">Current Price</Typography>
                            <Typography variant="h6" color="#a78bfa">{group.currentPrice.toFixed(6)}</Typography>
                          </Box>
                          <Box>
                            <Typography color="#94a3b8">Leverage</Typography>
                            <Typography variant="h6" color="#e2e8f0">{group.position.leverage}x</Typography>
                          </Box>
                          <Box>
                            <Typography color="#94a3b8">Used Margin</Typography>
                            <Typography variant="h6" color="#a78bfa">${group.position.allocatedMargin.toFixed(2)}</Typography>
                          </Box>
                          <Box>
                            <Typography color="#94a3b8">Risk Amount</Typography>
                            <Typography variant="h6" color="#94a3b8">${group.position.riskAmount.toFixed(2)}</Typography>
                          </Box>
                          <Box>
                            <Typography color="#94a3b8">Timeframe</Typography>
                            <Typography variant="h6" color="#60a5fa">
                              {group.position.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'}
                            </Typography>
                          </Box>
                          <Box>
                            <Typography color="#94a3b8">Entry Time</Typography>
                            <Typography variant="h6" color="#94a3b8">{new Date(group.position.entryTime).toLocaleString()}</Typography>
                          </Box>
                        </Box>
                      </Stack>
                    ) : (
                      <Typography color="#94a3b8" sx={{ py: 4, textAlign: 'center' }}>Position pending entry</Typography>
                    )}

                    {group.pendingOrders.length > 0 && (
                      <>
                        <Divider sx={{ my: 4, backgroundColor: '#334155' }} />
                        <Typography variant="h6" color="#60a5fa" mb={2}>Pending Orders</Typography>
                        <Table size="medium">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Type</TableCell>
                              <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Trigger Price</TableCell>
                              <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Quantity</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {group.pendingOrders.map((o) => (
                              <TableRow key={o.ClientId} hover>
                                <TableCell>
                                  <Chip
                                    label={o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                                    color={o.type === 'STOP_MARKET' ? 'error' : 'success'}
                                    variant="filled"
                                  />
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0', fontWeight: 600 }}>
                                  {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                                </TableCell>
                                <TableCell sx={{ color: '#e2e8f0' }}>{o.Qty.toLocaleString()}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}

          <Card sx={{ mt: 6, background: 'rgba(15,23,42,0.9)', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
            <CardContent sx={{ p: 4 }}>
              <Typography variant="h5" color="#60a5fa" mb={3} fontWeight={700}>
                Trade History
              </Typography>
              {history.length === 0 ? (
                <Typography color="#64748b" sx={{ py: 6, textAlign: 'center' }}>No trades yet</Typography>
              ) : (
                <>
                  <TableContainer component={Paper} sx={{ background: 'transparent', boxShadow: 'none' }}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Time</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Symbol</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Side</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Pattern</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Qty</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Entry</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>PnL</TableCell>
                          <TableCell sx={{ color: '#94a3b8', fontWeight: 600 }}>Exit Type</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.map((t, i) => (
                          <TableRow key={i} hover sx={{ '&:hover': { backgroundColor: 'rgba(96,165,250,0.05)' } }}>
                            <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#60a5fa', fontWeight: 600 }}>{t.symbol}</TableCell>
                            <TableCell>
                              <Chip
                                label={`${t.side} ${t.positionSide}`}
                                color={t.side === 'BUY' ? 'success' : 'error'}
                                size="small"
                              />
                            </TableCell>
                            <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                            <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                            <TableCell sx={{ color: t.isWin ? '#00ff9d' : '#ff3860', fontWeight: 'bold' }}>
                              {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Chip label={t.exitType} color={t.exitType === 'TP' ? 'success' : 'error'} size="small" />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Pagination
                    count={historyTotalPages}
                    page={historyPage}
                    onChange={(_, p) => loadHistory(p)}
                    color="primary"
                    sx={{ mt: 4, display: 'flex', justifyContent: 'center' }}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;


/*

import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
} from '@mui/material';
import { Refresh } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: string;
  historyCheckCandles?: number;
  currentPrice?: number;
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: string;
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          console.log('Received live-data:', data);
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];

          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.currentPrice || p.entryPrice;
          });

          const groups: Record<string, PositionGroup> = {};
          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
    getSocket()?.emit('get-bot-status');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004;
    return unrealized - commission;
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
        <Typography sx={{ mt: 2 }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} sx={{ mt: 2 }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error">{error}</Alert>
      </Snackbar>
      <Box sx={{ p: 3, minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)' }}>
        <Box sx={{ maxWidth: '1400px', mx: 'auto' }}>
          <Card sx={{ mb: 4, background: 'rgba(30,41,59,0.7)', backdropFilter: 'blur(12px)' }}>
            <CardContent>
              <Typography variant="h5" color="#60a5fa">
                Balance: {balance !== undefined && balance !== null ? `$${balance.toFixed(2)}` : '-'}
              </Typography>
              <Typography variant="h6" color="#e2e8f0" sx={{ mt: 1 }}>
                Today Entries: {todayEntries}/30000
              </Typography>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card>
              <CardContent>
                <Typography color="#94a3b8">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => (
              <Card key={group.key} sx={{ mb: 4, background: 'rgba(15,23,42,0.9)', borderRadius: 3 }}>
                <CardContent>
                  <Typography variant="h6" color="#60a5fa">
                    {group.symbol} • {group.positionSide} • {group.position?.side || 'Pending'} • Pattern: {group.position?.patternType || 'N/A'}
                  </Typography>
                  {group.position && group.currentPrice ? (
                    <Box sx={{ mt: 2 }}>
                      <Typography color="#e2e8f0">Qty: {group.position.qty.toLocaleString()}</Typography>
                      <Typography color="#3b82f6">Entry Price: {group.position.entryPrice.toFixed(6)}</Typography>
                      <Typography color="#a78bfa">Current Price: {group.currentPrice.toFixed(6)}</Typography>
                      <Typography color={calculateUnrealizedPnL(group.position, group.currentPrice) > 0 ? '#22c55e' : '#ef4444'} fontWeight="bold">
                        Unrealized PnL: {calculateUnrealizedPnL(group.position, group.currentPrice).toFixed(2)} USDT
                      </Typography>
                      <Typography color="#a78bfa">Used Margin: {group.position.allocatedMargin.toFixed(2)} USDT</Typography>
                      <Typography color="#94a3b8">Risk Amount: {group.position.riskAmount.toFixed(2)} USDT</Typography>
                      <Typography color="#e2e8f0">Leverage: {group.position.leverage}x</Typography>
                      <Typography color="#94a3b8">
                        Timeframe: {group.position?.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'}
                      </Typography>
                      <Typography color="#94a3b8">Entry Time: {new Date(group.position.entryTime).toLocaleString()}</Typography>
                    </Box>
                  ) : (
                    <Typography color="#94a3b8" sx={{ mt: 2 }}>Position pending entry</Typography>
                  )}
                  {group.pendingOrders.length > 0 && (
                    <Box sx={{ mt: 3 }}>
                      <Typography variant="subtitle1" color="#60a5fa">Pending Orders</Typography>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell sx={{ color: '#94a3b8' }}>Type</TableCell>
                            <TableCell sx={{ color: '#94a3b8' }}>Trigger Price</TableCell>
                            <TableCell sx={{ color: '#94a3b8' }}>Qty</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {group.pendingOrders.map((o) => (
                            <TableRow key={o.ClientId}>
                              <TableCell sx={{ color: o.type === 'STOP_MARKET' ? '#ef4444' : '#22c55e' }}>
                                {o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                              </TableCell>
                              <TableCell sx={{ color: '#e2e8f0' }}>
                                {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                              </TableCell>
                              <TableCell sx={{ color: '#e2e8f0' }}>{o.Qty.toLocaleString()}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Box>
                  )}
                </CardContent>
              </Card>
            ))
          )}

          <Card sx={{ mt: 5 }}>
            <CardContent>
              <Typography variant="h6" color="#60a5fa">Trade History</Typography>
              {history.length === 0 ? (
                <Typography color="#94a3b8" sx={{ mt: 2 }}>No trades yet</Typography>
              ) : (
                <TableContainer component={Paper} sx={{ mt: 2, background: 'rgba(30,41,59,0.6)' }}>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ color: '#94a3b8' }}>Time</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Symbol</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Side</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Pattern</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Qty</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Entry</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Exit</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>PnL</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Exit Type</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {history.map((t, i) => (
                        <TableRow key={i}>
                          <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                          <TableCell sx={{ color: '#60a5fa' }}>{t.symbol}</TableCell>
                          <TableCell sx={{ color: t.side === 'BUY' ? '#22c55e' : '#ef4444' }}>
                            {t.side} {t.positionSide}
                          </TableCell>
                          <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                          <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                          <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                          <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                          <TableCell sx={{ color: t.isWin ? '#22c55e' : '#ef4444', fontWeight: 'bold' }}>
                            {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                          </TableCell>
                          <TableCell sx={{ color: t.exitType === 'TP' ? '#22c55e' : '#ef4444' }}>{t.exitType}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
              <Pagination
                count={historyTotalPages}
                page={historyPage}
                onChange={(_, p) => loadHistory(p)}
                sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}
              />
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;
*/

/*
import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Alert,
  CircularProgress,
  Snackbar,
  Pagination,
  TableContainer,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Button,
} from '@mui/material';
import { Refresh } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket,
  getSocket,
  verifyToken,
  logout,
  requestTradeHistory,
} from '../api/api';
import Header from './Header';

interface LivePosition {
  historyCheckCandles: any;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  allocatedMargin: number;
  leverage: number;
  entryTime: string;
  riskAmount: number;
  patternType: 'HAMMER' | 'INVERSE_HAMMER';
  currentPrice?: number; // will add from live data if needed
}

interface PendingOrder {
  ClientId: string;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  stopLoss: number;
}

interface Trade {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sl: number;
  tp: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  isWin: boolean;
  exitType: 'SL' | 'TP';
  leverage: number;
  riskAmount: number;
  allocatedMargin: number;
  patternType: 'HAMMER' | 'INVERSE_HAMMER';
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
  currentPrice?: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [todayEntries, setTodayEntries] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Trade[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({});

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const resp: any = await requestTradeHistory(page, 10);
      setHistory(resp.trades || []);
      setHistoryTotalPages(resp.pagination?.totalPages || 1);
      setHistoryPage(page);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    let socket: any = null;
    let hasReceivedData = false;

    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        await verifyToken();
        socket = initializeSocket(token, accountId);

        const stopLoading = () => {
          if (!hasReceivedData) {
            hasReceivedData = true;
            setLoading(false);
          }
        };

        socket.on('equity-balance-manual', (data: any) => {
          setBalance(data.balance);
          stopLoading();
        });

        socket.on('live-data', (data: any) => {
          console.log('Received live-data:', data);
          const positions: LivePosition[] = data.positionData?.positions || [];
          const pending: PendingOrder[] = data.positionData?.filteredPendingOrders || [];

          // Extract current prices from klines or mark price if available
          // Assuming backend sends current price somewhere; here we use entryPrice as fallback
          const prices: Record<string, number> = {};
          positions.forEach(p => {
            prices[p.symbol] = p.entryPrice; // replace with real mark price if sent
          });

          setCurrentPrices(prices);

          const groups: Record<string, PositionGroup> = {};

          positions.forEach((p: LivePosition) => {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, pendingOrders: [], currentPrice: prices[p.symbol] };
            }
            groups[key].position = p;
          });

          pending.forEach((o: PendingOrder) => {
            const key = `${o.symbol}_${o.positionSide}`;
            if (!groups[key]) {
              groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [], currentPrice: prices[o.symbol] };
            }
            groups[key].pendingOrders.push(o);
          });

          setGroupedData(Object.values(groups));
          stopLoading();
        });

        socket.on('bot-status', (data: any) => {
          setTodayEntries(data.todayEntries || data.dailyEntries || 0);
          stopLoading();
        });

        socket.on('trade-history-response', (resp: any) => {
          setHistory(resp.trades || []);
          setHistoryTotalPages(resp.pagination?.totalPages || 1);
          stopLoading();
        });

        setTimeout(() => stopLoading(), 8000);
      } catch (err: any) {
        setError(err.message || 'Failed');
        setLoading(false);
      }
    };

    init();

    return () => {
      if (socket) {
        socket.off('equity-balance-manual');
        socket.off('live-data');
        socket.off('bot-status');
        socket.off('trade-history-response');
        socket.disconnect();
      }
    };
  }, [navigate, accountId]);

  const handleManualRefresh = () => {
    setError('');
    getSocket()?.emit('refresh-data');
  };

  const calculateUnrealizedPnL = (position: LivePosition, currentPrice: number) => {
    const pnlSign = position.side === 'BUY' ? 1 : -1;
    const unrealized = position.qty * (currentPrice - position.entryPrice) * pnlSign;
    const commission = position.qty * (position.entryPrice + currentPrice) * 0.0004; // 0.04%
    return unrealized - commission;
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
        <Typography sx={{ mt: 2 }}>Connecting to server...</Typography>
        <Button onClick={handleManualRefresh} startIcon={<Refresh />} sx={{ mt: 2 }}>
          Refresh
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Header onRefresh={handleManualRefresh} onLogout={() => { logout(); navigate('/login'); }} />
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError('')}>
        <Alert severity="error">{error}</Alert>
      </Snackbar>
      <Box sx={{ p: 3, minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)' }}>
        <Box sx={{ maxWidth: '1400px', mx: 'auto' }}>
          <Card sx={{ mb: 4, background: 'rgba(30,41,59,0.7)', backdropFilter: 'blur(12px)' }}>
            <CardContent>
              <Typography variant="h5" color="#60a5fa">
                Balance: {balance !== undefined && balance !== null ? `$${balance.toFixed(2)}` : '-'}
              </Typography>
              <Typography variant="h6" color="#e2e8f0" sx={{ mt: 1 }}>
                Today Entries: {todayEntries}/30
              </Typography>
            </CardContent>
          </Card>

          {groupedData.length === 0 ? (
            <Card>
              <CardContent>
                <Typography color="#94a3b8">No open positions or pending orders</Typography>
              </CardContent>
            </Card>
          ) : (
            groupedData.map((group) => (
              <Card key={group.key} sx={{ mb: 4, background: 'rgba(15,23,42,0.9)', borderRadius: 3 }}>
                <CardContent>
                  <Typography variant="h6" color="#60a5fa">
                    {group.symbol} • {group.positionSide} • {group.position?.side || 'Pending'} • Pattern: {group.position?.patternType || 'N/A'}
                  </Typography>
                  {group.position && group.currentPrice ? (
                    <Box sx={{ mt: 2 }}>
                      <Typography color="#e2e8f0">Qty: {group.position.qty.toLocaleString()}</Typography>
                      <Typography color="#3b82f6">Entry Price: {group.position.entryPrice.toFixed(6)}</Typography>
                      <Typography color="#a78bfa">Current Price: {group.currentPrice.toFixed(6)}</Typography>
                      <Typography color={calculateUnrealizedPnL(group.position, group.currentPrice) > 0 ? '#22c55e' : '#ef4444'} fontWeight="bold">
                        Unrealized PnL: {calculateUnrealizedPnL(group.position, group.currentPrice).toFixed(2)} USDT
                      </Typography>
                      <Typography color="#a78bfa">Used Margin: {group.position.allocatedMargin.toFixed(2)} USDT</Typography>
                      <Typography color="#94a3b8">Risk Amount: {group.position.riskAmount.toFixed(2)} USDT</Typography>
                      <Typography color="#e2e8f0">Leverage: {group.position.leverage}x</Typography>
                                            <Typography color="#94a3b8">Timeframe: {group.position?.historyCheckCandles ? `${group.position.historyCheckCandles / 60}h` : 'N/A'}</Typography>
                      <Typography color="#94a3b8">Entry Time: {new Date(group.position.entryTime).toLocaleString()}</Typography>
                    </Box>
                  ) : (
                    <Typography color="#94a3b8" sx={{ mt: 2 }}>Position pending entry</Typography>
                  )}
                  {group.pendingOrders.length > 0 && (
                    <Box sx={{ mt: 3 }}>
                      <Typography variant="subtitle1" color="#60a5fa">Pending Orders</Typography>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell sx={{ color: '#94a3b8' }}>Type</TableCell>
                            <TableCell sx={{ color: '#94a3b8' }}>Trigger Price</TableCell>
                            <TableCell sx={{ color: '#94a3b8' }}>Qty</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {group.pendingOrders.map((o) => (
                            <TableRow key={o.ClientId}>
                              <TableCell sx={{ color: o.type === 'STOP_MARKET' ? '#ef4444' : '#22c55e' }}>
                                {o.type === 'STOP_MARKET' ? 'STOP LOSS' : 'TAKE PROFIT'}
                              </TableCell>
                              <TableCell sx={{ color: '#e2e8f0' }}>
                                {o.stopLoss ? o.stopLoss.toFixed(6) : '-'}
                              </TableCell>
                              <TableCell sx={{ color: '#e2e8f0' }}>{o.Qty.toLocaleString()}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Box>
                  )}
                </CardContent>
              </Card>
            ))
          )}

          <Card sx={{ mt: 5 }}>
            <CardContent>
              <Typography variant="h6" color="#60a5fa">Trade History</Typography>
              {history.length === 0 ? (
                <Typography color="#94a3b8" sx={{ mt: 2 }}>No trades yet</Typography>
              ) : (
                <TableContainer component={Paper} sx={{ mt: 2, background: 'rgba(30,41,59,0.6)' }}>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ color: '#94a3b8' }}>Time</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Symbol</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Side</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Pattern</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Qty</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Entry</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Exit</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>PnL</TableCell>
                        <TableCell sx={{ color: '#94a3b8' }}>Exit Type</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {history.map((t, i) => (
                        <TableRow key={i}>
                          <TableCell sx={{ color: '#e2e8f0' }}>{new Date(t.exitTime).toLocaleString()}</TableCell>
                          <TableCell sx={{ color: '#60a5fa' }}>{t.symbol}</TableCell>
                          <TableCell sx={{ color: t.side === 'BUY' ? '#22c55e' : '#ef4444' }}>
                            {t.side} {t.positionSide}
                          </TableCell>
                          <TableCell sx={{ color: '#a78bfa' }}>{t.patternType}</TableCell>
                          <TableCell sx={{ color: '#e2e8f0' }}>{t.qty.toLocaleString()}</TableCell>
                          <TableCell sx={{ color: '#3b82f6' }}>{t.entryPrice.toFixed(6)}</TableCell>
                          <TableCell sx={{ color: '#3b82f6' }}>{t.exitPrice.toFixed(6)}</TableCell>
                          <TableCell sx={{ color: t.isWin ? '#22c55e' : '#ef4444', fontWeight: 'bold' }}>
                            {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                          </TableCell>
                          <TableCell sx={{ color: t.exitType === 'TP' ? '#22c55e' : '#ef4444' }}>{t.exitType}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
              <Pagination
                count={historyTotalPages}
                page={historyPage}
                onChange={(_, p) => loadHistory(p)}
                sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}
              />
            </CardContent>
          </Card>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;
*/
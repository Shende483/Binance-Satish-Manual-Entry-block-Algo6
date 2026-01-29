
import React, { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardContent, Typography, TextField, Button, FormControl, InputLabel, OutlinedInput, InputAdornment, IconButton, Alert } from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import Header from './Header';
import { verifyToken, login } from '../api/api';
import { ThemeContext } from '../main';
import _ from 'lodash'; // Lodash import for debounce

const Login: React.FC = () => {
  useContext(ThemeContext);
  const [emailOrMobile, setEmailOrMobile] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const checkToken = _.debounce(async () => {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        await verifyToken();
        navigate('/dashboard', { replace: true });
      } catch (err) {
        localStorage.removeItem('token');
        setError('Invalid or expired token. Please log in again.');
      }
    }
  }, 500); // 500ms debounce delay

  useEffect(() => {
    checkToken();
  }, [navigate]);

  const handleSubmit = _.debounce(async () => {
    try {
      const response = await login({ emailOrMobile, password });
      if (response.message === 'Login successful' && response.token) {
        localStorage.setItem('token', response.token);
        setError('');
        navigate('/dashboard', { replace: true });
      } else {
        setError('Unexpected response from server.');
      }
    } catch (error: any) {
      setError(error.response?.data?.error || 'Login failed. Please check your credentials.');
      console.error('Login failed:', error);
    }
  },2000); // 500ms debounce delay

  return (
    <>
      <Header onRefresh={function (): void {
        throw new Error('Function not implemented.');
      } } onLogout={function (): void {
        throw new Error('Function not implemented.');
      } } />
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'center', bgcolor: 'background.default', minHeight: '100vh' }}>
        <Card sx={{ maxWidth: 400, width: '100%', maxHeight: 400, overflow: 'auto' }}>
          <CardContent sx={{ p: 2 }}>
            <Typography variant="h5" gutterBottom color="text.primary">
              Login Page
            </Typography>
            {error && (
              <Alert severity="error" sx={{ mb: 1.5 }}>
                {error}
              </Alert>
            )}
            <Box sx={{ mb: 1 }}>
              <TextField
                fullWidth
                label="Email or Mobile"
                variant="outlined"
                value={emailOrMobile}
                onChange={(e) => setEmailOrMobile(e.target.value)}
                sx={{ mb: 1.5 }}
              />
              <FormControl fullWidth variant="outlined">
                <InputLabel>Password</InputLabel>
                <OutlinedInput
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  endAdornment={
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowPassword(!showPassword)}
                        edge="end"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  }
                  label="Password"
                />
              </FormControl>
              <Button
                fullWidth
                variant="contained"
                color="primary"
                onClick={handleSubmit}
                sx={{ mt: 1.5 }}
              >
                Login
              </Button>
            </Box>
            <Box component="nav" sx={{ mb: 1 }}>
              <Button onClick={() => navigate('/signup')} color="primary">
                Don't have an account? Signup
              </Button>
            </Box>
          </CardContent>
        </Card>
      </Box>
    </>
  );
};

export default Login;

/*
import React, { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardContent, Typography, TextField, Button, FormControl, InputLabel, OutlinedInput, InputAdornment, IconButton, Alert } from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import Header from './Header';
import { verifyToken, login } from '../api/api';
import { ThemeContext } from '../main';


const Login: React.FC = () => {
 useContext(ThemeContext);
  const [emailOrMobile, setEmailOrMobile] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const checkToken = async () => {
      const token = localStorage.getItem('token');
      if (token) {
        try {
          await verifyToken();
          navigate('/dashboard', { replace: true });
        } catch (err) {
          localStorage.removeItem('token');
          setError('Invalid or expired token. Please log in again.');
        }
      }
    };
    checkToken();
  }, [navigate]);

  const handleSubmit = async () => {
    try {
      const response = await login({ emailOrMobile, password });
      if (response.message === 'Login successful' && response.token) {
        localStorage.setItem('token', response.token);
        setError('');
        navigate('/dashboard', { replace: true });
      } else {
        setError('Unexpected response from server.');
      }
    } catch (error: any) {
      setError(error.response?.data?.error || 'Login failed. Please check your credentials.');
      console.error('Login failed:', error);
    }
  };

  return (
    <>
      <Header />
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'center', bgcolor: 'background.default', minHeight: '100vh' }}>
        <Card sx={{ maxWidth: 400, width: '100%', maxHeight: 400, overflow: 'auto' }}>
          <CardContent sx={{ p: 2 }}>
            <Typography variant="h5" gutterBottom color="text.primary">
              Login Page
            </Typography>
            {error && (
              <Alert severity="error" sx={{ mb: 1.5 }}>
                {error}
              </Alert>
            )}
            <Box sx={{ mb: 1 }}>
              <TextField
                fullWidth
                label="Email or Mobile"
                variant="outlined"
                value={emailOrMobile}
                onChange={(e) => setEmailOrMobile(e.target.value)}
                sx={{ mb: 1.5 }}
              />
              <FormControl fullWidth variant="outlined">
                <InputLabel>Password</InputLabel>
                <OutlinedInput
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  endAdornment={
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowPassword(!showPassword)}
                        edge="end"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  }
                  label="Password"
                />
              </FormControl>
              <Button
                fullWidth
                variant="contained"
                color="primary"
                onClick={handleSubmit}
                sx={{ mt: 1.5 }}
              >
                Login
              </Button>
            </Box>
            <Box component="nav" sx={{ mb: 1 }}>
              <Button onClick={() => navigate('/signup')} color="primary">
                Don't have an account? Signup
              </Button>
            </Box>
          </CardContent>
        </Card>
      </Box>
    </>
  );
};

export default Login;
*/
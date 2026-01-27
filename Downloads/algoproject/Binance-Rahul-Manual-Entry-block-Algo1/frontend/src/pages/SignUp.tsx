
import React, { useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, CardContent, Typography, TextField, Button, FormControl, InputLabel, OutlinedInput, InputAdornment, IconButton, Alert } from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import Header from './Header';
import { signup } from '../api/api';
import { ThemeContext } from '../main';
import _ from 'lodash'; // Lodash import for debounce

const Signup: React.FC = () => {
  useContext(ThemeContext);
  const [formData, setFormData] = useState({
    email: '',
    mobile: '',
    password: '',
    firstName: '',
    lastName: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = _.debounce(async () => {
    try {
      const response = await signup(formData);
      const token = response.token;
      localStorage.setItem('token', token);
      setError('');
      navigate('/dashboard');
    } catch (error) {
      setError('Signup failed.');
      console.error('Signup failed:', error);
    }
  }, 2000); // 500ms debounce delay

  return (
    <>
      <Header onRefresh={function (): void {
        throw new Error('Function not implemented.');
      } } onLogout={function (): void {
        throw new Error('Function not implemented.');
      } } />
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'center', bgcolor: 'background.default', minHeight: '100vh' }}>
        <Card sx={{ maxWidth: 400, width: '100%', maxHeight: 600, overflow: 'auto' }}>
          <CardContent sx={{ p: 2 }}>
            <Typography variant="h5" gutterBottom color="text.primary">
              Signup Page
            </Typography>
            {error && (
              <Alert severity="error" sx={{ mb: 1.5 }}>
                {error}
              </Alert>
            )}
            <Box sx={{ mb: 1 }}>
              <TextField
                fullWidth
                label="Email"
                name="email"
                variant="outlined"
                value={formData.email}
                onChange={handleChange}
                sx={{ mb: 1.5 }}
              />
              <TextField
                fullWidth
                label="Mobile"
                name="mobile"
                variant="outlined"
                value={formData.mobile}
                onChange={handleChange}
                sx={{ mb: 1.5 }}
              />
              <FormControl fullWidth variant="outlined">
                <InputLabel>Password</InputLabel>
                <OutlinedInput
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
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
              <TextField
                fullWidth
                label="First Name"
                name="firstName"
                variant="outlined"
                value={formData.firstName}
                onChange={handleChange}
                sx={{ mb: 1.5, mt: 1.5 }}
              />
              <TextField
                fullWidth
                label="Last Name"
                name="lastName"
                variant="outlined"
                value={formData.lastName}
                onChange={handleChange}
                sx={{ mb: 1.5 }}
              />
              <Button
                fullWidth
                variant="contained"
                color="primary"
                onClick={handleSubmit}
                sx={{ mt: 1.5 }}
              >
                Signup
              </Button>
            </Box>
            <Box component="nav" sx={{ mb: 1 }}>
              <Button onClick={() => navigate('/login')} color="primary">
                Already have an account? Login
              </Button>
            </Box>
          </CardContent>
        </Card>
      </Box>
    </>
  );
};

export default Signup;



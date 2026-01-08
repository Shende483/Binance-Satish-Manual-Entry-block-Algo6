import React from 'react';
import { AppBar, Toolbar, Typography, Box, Button } from '@mui/material';

interface HeaderProps {
  onRefresh: () => void;
  onLogout: () => void;
}

const Header: React.FC<HeaderProps> = ({ onRefresh, onLogout }) => {
  return (
    <AppBar position="static" sx={{ background: 'linear-gradient(to right, #275d89ff, #050a1f)' }}>
      <Toolbar>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <Typography variant="h5" sx={{ fontSize: '1.25rem', fontWeight: 700, color: '#beb9c6ff' }}>
            Dashboard
          </Typography>
          <Box display="flex" gap={2}>
            <Button
              variant="outlined"
              onClick={onRefresh}
              sx={{
                color: '#d4d9e6',
                borderColor: '#10e9e9ff',
                fontSize: '0.9rem',
                py: 0.8,
                px: 2,
                '&:hover': { bgcolor: '#1e2a4d', borderColor: '#94d89bff' },
              }}
            >
              Refresh
            </Button>
            <Button
              variant="outlined"
              onClick={onLogout}
              sx={{
                color: '#d4d9e6',
                borderColor: '#10e9e9ff',
                fontSize: '0.9rem',
                py: 0.8,
                px: 2,
                '&:hover': { bgcolor: '#1e2a4d', borderColor: '#94d89bff' },
              }}
            >
              Logout
            </Button>
          </Box>
        </Box>
      </Toolbar>
    </AppBar>
  );
};

export default Header;
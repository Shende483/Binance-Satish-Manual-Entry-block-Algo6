import { createTheme } from '@mui/material/styles';
import { red } from '@mui/material/colors';

// Define professional theme structure
const getTheme = (mode: 'light' | 'dark') =>
  createTheme({
    palette: {
      mode,
      primary: {
        main: '#1976d2', // Blue
        light: '#42a5f5',
        dark: '#1565c0',
        contrastText: '#ffffff',
      },
      secondary: {
        main: '#dc004e', // Pink
        light: '#ff4081',
        dark: '#c51162',
        contrastText: '#ffffff',
      },
      error: {
        main: red[700],
        light: red[400],
        dark: red[900],
      },
      warning: {
        main: '#ed6c02',
        light: '#ff9800',
        dark: '#e65100',
      },
      info: {
        main: '#0288d1',
        light: '#03a9f4',
        dark: '#01579b',
      },
      success: {
        main: '#2e7d32',
        light: '#4caf50',
        dark: '#1b5e20',
      },
      background: {
        default: mode === 'light' ? '#f5f5f5' : '#121212',
        paper: mode === 'light' ? '#ffffff' : '#1e1e1e',
      },
      text: {
        primary: mode === 'light' ? '#212121' : '#ffffff',
        secondary: mode === 'light' ? '#757575' : '#b0b0b0',
        disabled: mode === 'light' ? '#bdbdbd' : '#616161',
      },
    },
    typography: {
      fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
      h1: {
        fontSize: '2.5rem',
        fontWeight: 500,
        lineHeight: 1.2,
      },
      h2: {
        fontSize: '2rem',
        fontWeight: 500,
        lineHeight: 1.3,
      },
      h3: {
        fontSize: '1.75rem',
        fontWeight: 400,
      },
      h4: {
        fontSize: '1.5rem',
        fontWeight: 400,
      },
      body1: {
        fontSize: '1rem',
        lineHeight: 1.5,
      },
      body2: {
        fontSize: '0.875rem',
        lineHeight: 1.43,
      },
      button: {
        textTransform: 'none',
        fontWeight: 500,
      },
    },
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            padding: '8px 16px',
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            boxShadow: mode === 'light' ? '0 4px 12px rgba(0,0,0,0.1)' : '0 4px 12px rgba(0,0,0,0.3)',
          },
        },
      },
    },
    spacing: 8,
    shape: {
      borderRadius: 8,
    },
  });

export default getTheme;
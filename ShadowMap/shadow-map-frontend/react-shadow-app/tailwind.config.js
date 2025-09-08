/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        shadow: {
          primary: '#01112f',
          secondary: '#0f1419',
        },
        map: {
          building: '#ff6b6b',
          highrise: '#0064ff',
        }
      },
    },
  },
  plugins: [],
}

#!/bin/bash

# DATUM Setup Script - Installs everything and runs the dev server

echo "╔════════════════════════════════════════╗"
echo "║     DATUM - Complete Setup & Run       ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Check Node.js
echo "Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found!"
    echo "   Install from: https://nodejs.org/ (LTS recommended)"
    exit 1
fi
NODE_VERSION=$(node --version)
echo "✓ Node.js $NODE_VERSION found"

# Check npm
echo "Checking npm..."
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found!"
    echo "   npm comes with Node.js. Install from: https://nodejs.org/"
    exit 1
fi
NPM_VERSION=$(npm --version)
echo "✓ npm $NPM_VERSION found"

echo ""

# Install UI dependencies
echo "Installing UI dependencies..."
echo "Running: npm --prefix ui install"
npm --prefix ui install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install UI dependencies"
    exit 1
fi
echo "✓ UI dependencies installed"

echo ""
echo "╔════════════════════════════════════════╗"
echo "║    Starting Development Server...      ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Your app will be available at:"
echo "   http://localhost:5273"
echo ""
echo "Commands:"
echo "   Build for production: npm --prefix ui run build"
echo "   Run tests: npm --prefix ui run test"
echo ""

# Start dev server
npm --prefix ui run dev

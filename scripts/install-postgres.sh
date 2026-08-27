#!/bin/bash
# PostgreSQL Installation Script for Ubuntu
# This script installs PostgreSQL and sets it up for the home-ai project

set -e

echo "Installing PostgreSQL..."

# Update package list
sudo apt update

# Install PostgreSQL and common contrib packages
sudo apt install -y postgresql postgresql-contrib

# Start and enable PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Get PostgreSQL version
PG_VERSION=$(psql --version | awk '{print $3}' | cut -d. -f1,2)
echo "PostgreSQL version: $(psql --version)"

# Create database and user matching your project configuration
echo "Setting up database and user for home-ai project..."

# Switch to postgres user to create database and user
sudo -u postgres psql <<EOF
-- Create database
CREATE DATABASE homeai;

-- Create user
CREATE USER homeai WITH PASSWORD 'homeai_password';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE homeai TO homeai;

-- Connect to homeai database and grant schema privileges
\c homeai
GRANT ALL ON SCHEMA public TO homeai;

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
EOF

# Run the initialization script
echo "Running initialization script..."
sudo -u postgres psql -d homeai -f /home/daurham/home-ai/postgres/init.sql

echo ""
echo "PostgreSQL installation complete!"
echo ""
echo "Connection details:"
echo "  Host: localhost"
echo "  Port: 5432"
echo "  Database: homeai"
echo "  User: homeai"
echo "  Password: homeai_password"
echo ""
echo "To connect, use:"
echo "  psql -h localhost -U homeai -d homeai"
echo ""
echo "Or update your .env file to use:"
echo "  DATABASE_URL=postgresql://homeai:homeai_password@localhost:5432/homeai"


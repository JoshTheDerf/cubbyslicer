# AGENTS.md

Guidance for AI agents working in the cubby-slicer repository.

## What this is

CubbySlicer is a 3D printing slicer application. It converts 3D models into instructions for 3D printers.

## Commands

```bash
npm install
npm run dev              # Start development server
npm run build            # Build for production
npm run test             # Run tests
```

## Architecture & Tech Stack

- **Language**: TypeScript
- **Build**: Vite
- **Domain**: 3D printing and slicer technology
- **Output**: G-code for 3D printers

## Project Structure

- `src/` - Main source code
- `dist/` - Built output
- `public/` - Public assets
- `scripts/` - Build and utility scripts
- `README.md` - Project documentation

## Key Features

- 3D model slicing
- G-code generation
- Support for various 3D printers
- Web-based interface

## Integration

Integrates with other cubby* projects:
- **cubbycad** - CAD application
- **cad-project** - Core CAD functionality
- **compose** - Docker deployment

## Important Notes

- Slicing algorithms are performance-critical
- G-code output must be accurate for printer compatibility
- 3D model handling requires careful processing
- Web-based for accessibility

## Gotchas

- G-code dialects vary between printer manufacturers
- Slicing parameters affect print quality significantly
- Large 3D models may require optimization
- Test with actual 3D printers when possible
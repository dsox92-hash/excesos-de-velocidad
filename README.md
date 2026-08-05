# Cootransblan Excesos de Velocidad

Aplicacion React + Vite para detectar excesos de velocidad, ubicarlos en mapa y exportar evidencia administrativa.

## Desarrollo local

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Despliegue en GitHub Pages

El proyecto ya incluye workflow en [.github/workflows/deploy-github-pages.yml](.github/workflows/deploy-github-pages.yml) y configuracion de `base` en [vite.config.js](vite.config.js).

1. Crear un repositorio en GitHub (vacio).
2. Conectar este proyecto al repositorio remoto.
3. Hacer push a la rama `main`.
4. En GitHub: `Settings > Pages`, seleccionar `Source: GitHub Actions`.
5. Esperar que termine el workflow `Deploy to GitHub Pages`.

Comandos sugeridos:

```bash
git add .
git commit -m "Configuracion inicial para GitHub Pages"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

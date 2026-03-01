<template>
  <div id="app" class="battlepass-app">
    <main class="battlepass-main">
      <EditorView />
    </main>
    <AppFooter />
  </div>
</template>

<script setup>
import EditorView from './views/EditorView.vue'
import AppFooter from './components/AppFooter.vue'
</script>

<style scoped>
.battlepass-app {
  min-height: 100vh;
  color: var(--color-text);
  background: var(--color-bg);
}

.battlepass-main {
  display: flex;
  flex-direction: column;
}
</style>

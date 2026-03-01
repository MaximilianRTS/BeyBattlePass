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
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--color-text);
  background: var(--color-bg);
}

.battlepass-main {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>

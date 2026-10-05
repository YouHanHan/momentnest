<script setup lang="ts">
import { NConfigProvider, dateZhCN, zhCN } from 'naive-ui'
import { uiTheme } from '../ui-theme'
import '../ui-controls.css'
</script>

<template><NConfigProvider abstract :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="uiTheme"><slot /></NConfigProvider></template>

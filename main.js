// Leaf colors (string_color) live in colors.js

// Global variables to store loaded data
let streetData = {};
let shapesData = {};

// Load both JSON files
Promise.all([
    d3.json('street_color_shapes.json'),
    d3.json('shapes.json')
]).then(([streets, shapes]) => {
    streetData = streets;
    shapesData = shapes;
    
    // Populate the datalist with street names
    populateStreetList();
    
    // Set up event listener for street input
    setupEventListeners();
}).catch(error => {
    console.error('Error loading data:', error);
});

// Populate the datalist with street names
function populateStreetList() {
    const datalist = document.getElementById('street-list');
    const streetNames = Object.keys(streetData);
    
    streetNames.forEach(street => {
        const option = document.createElement('option');
        option.value = street;
        datalist.appendChild(option);
    });
}

// Set up event listeners
function setupEventListeners() {
    const input = document.getElementById('street-input');
    
    input.addEventListener('change', function() {
        const streetName = this.value;
        if (streetData[streetName]) {
            displayLeaves(streetName);
            LeafMap.selectStreet(streetName);
        } else {
            clearDisplay();
            LeafMap.clearStreet();
        }
    });
    
    input.addEventListener('input', function() {
        const streetName = this.value;
        if (streetData[streetName]) {
            displayLeaves(streetName);
            LeafMap.selectStreet(streetName);
        }
    });

    // Borough toggles and "Reset view" on the map clear the selected street
    LeafMap.onStreetCleared = () => {
        input.value = '';
        clearDisplay();
    };
}

// Clear the leaf display
function clearDisplay() {
    const display = document.getElementById('leaf-display');
    display.innerHTML = '';
}

// Display leaves for a selected street
function displayLeaves(streetName) {
    const display = document.getElementById('leaf-display');
    display.innerHTML = '';
    
    const streetInfo = streetData[streetName];
    
    // Iterate through each shape for this street
    for (const shapeName in streetInfo) {
        const colorArray = streetInfo[shapeName];
        
        // Iterate through each color object in the array
        colorArray.forEach(colorObj => {
            // Each colorObj has one key (color name) and value (count)
            for (const colorName in colorObj) {
                const count = colorObj[colorName];
                
                // Create a leaf for this shape-color combination
                createLeaf(shapeName, colorName, count);
            }
        });
    }
}

// Create an individual leaf element
function createLeaf(shapeName, colorName, count) {
    const display = document.getElementById('leaf-display');
    
    // Get shape data
    const shapeData = shapesData[shapeName];
    if (!shapeData) {
        console.warn(`Shape not found: ${shapeName}`);
        return;
    }
    
    const [viewBox, pathData] = shapeData;
    
    // Get color(s)
    const colors = string_color[colorName] || ["#787878"];
    
    // Create 'count' number of leaves
    for (let i = 0; i < count; i++) {
        // Create SVG element
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', viewBox);
        svg.classList.add('leaf');
        
        // If multiple colors, create gradient
        if (colors.length > 1) {
            // Create a unique gradient ID
            const gradientId = `gradient-${shapeName}-${colorName}-${i}-${Math.random().toString(36).substr(2, 9)}`;
            
            // Create defs and gradient
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
            gradient.setAttribute('id', gradientId);
            gradient.setAttribute('x1', '0%');
            gradient.setAttribute('y1', '0%');
            gradient.setAttribute('x2', '100%');
            gradient.setAttribute('y2', '100%');
            
            // Add color stops
            colors.forEach((color, index) => {
                const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
                stop.setAttribute('offset', `${(index / (colors.length - 1)) * 100}%`);
                stop.setAttribute('stop-color', color);
                gradient.appendChild(stop);
            });
            
            defs.appendChild(gradient);
            svg.appendChild(defs);
            
            // Create path with gradient fill
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathData);
            path.setAttribute('fill', `url(#${gradientId})`);
            svg.appendChild(path);
        } else {
            // Single color
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathData);
            path.setAttribute('fill', colors[0]);
            svg.appendChild(path);
        }
        
        // Add SVG directly to display
        display.appendChild(svg);
    }
}

